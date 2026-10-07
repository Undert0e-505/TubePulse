export const UPDATE_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;
export const UPDATE_CHECK_MAX_BYTES = 64 * 1024;
export const UPDATE_CHECK_ENDPOINT = 'https://api.github.com/repos/Undert0e-505/TubePulse/releases/latest';
export const UPDATE_CACHE_KEY = '@tubepulse/app-update-v1';

const STABLE_VERSION_PATTERN = /^(?:v)?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

export function parseStableVersion(value) {
  const match = typeof value === 'string' ? STABLE_VERSION_PATTERN.exec(value) : null;
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part))) return null;
  return { major: parts[0], minor: parts[1], patch: parts[2] };
}

export function compareStableVersions(left, right) {
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  return 0;
}

export function validateReleaseUrl(tagName, value) {
  if (!parseStableVersion(tagName) || typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    const expectedPath = `/Undert0e-505/TubePulse/releases/tag/${tagName}`;
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com'
      || url.username || url.password || (url.port && url.port !== '443')
      || url.pathname !== expectedPath || url.search || url.hash) return null;
    return `https://github.com${expectedPath}`;
  } catch {
    return null;
  }
}

export function parseGitHubRelease(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.draft !== false || value.prerelease !== false
    || typeof value.tag_name !== 'string' || typeof value.html_url !== 'string') return null;
  const version = parseStableVersion(value.tag_name);
  const releaseUrl = validateReleaseUrl(value.tag_name, value.html_url);
  return version && releaseUrl
    ? { tagName: value.tag_name, version, releaseUrl }
    : null;
}

export function isSafeEtag(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 512
    && !/[\u0000-\u001f\u007f]/.test(value);
}

export function shouldCheckForUpdate(lastAttemptAt, now = Date.now()) {
  return !Number.isFinite(lastAttemptAt) || lastAttemptAt <= 0
    || (now >= lastAttemptAt && now - lastAttemptAt >= UPDATE_CHECK_INTERVAL_MS);
}

export function eligibleUpdate(release, installedVersion, dismissedTag) {
  const installed = parseStableVersion(installedVersion);
  if (!release || !installed || release.tagName === dismissedTag) return null;
  return compareStableVersions(release.version, installed) > 0 ? release : null;
}

export function normalizeUpdateCache(value) {
  const release = value?.release
    ? parseGitHubRelease({
      draft: false,
      prerelease: false,
      tag_name: value.release.tagName,
      html_url: value.release.releaseUrl,
    })
    : null;
  return {
    lastAttemptAt: Number.isFinite(Number(value?.lastAttemptAt)) ? Number(value.lastAttemptAt) : 0,
    etag: release && isSafeEtag(value?.etag) ? value.etag : null,
    release,
    dismissedTag: typeof value?.dismissedTag === 'string' ? value.dismissedTag : null,
    demoDismissedTag: typeof value?.demoDismissedTag === 'string' ? value.demoDismissedTag : null,
  };
}

export function demoUpdate(installedVersion, configuredTag, dismissedTag) {
  const installed = parseStableVersion(installedVersion);
  const configured = parseStableVersion(configuredTag);
  if (!installed || !configured) return null;
  const tagName = configuredTag.startsWith('v') ? configuredTag : `v${configuredTag}`;
  return eligibleUpdate({
    tagName,
    version: configured,
    releaseUrl: 'https://github.com/Undert0e-505/TubePulse/releases/latest',
  }, installedVersion, dismissedTag);
}

function utf8Size(value) {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff
      && value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) {
      bytes += 4;
      index++;
    } else bytes += 3;
  }
  return bytes;
}

export async function readUpdateCache(storage) {
  try {
    return normalizeUpdateCache(JSON.parse(await storage.getItem(UPDATE_CACHE_KEY) || '{}'));
  } catch {
    return normalizeUpdateCache(null);
  }
}

async function writeUpdateCache(storage, cache) {
  await storage.setItem(UPDATE_CACHE_KEY, JSON.stringify(cache));
  return cache;
}

export async function cachedAvailableUpdate({ storage, installedVersion, demoEnabled = false, demoTag = '' }) {
  const cache = await readUpdateCache(storage);
  return demoEnabled
    ? demoUpdate(installedVersion, demoTag, cache.demoDismissedTag)
    : eligibleUpdate(cache.release, installedVersion, cache.dismissedTag);
}

export async function refreshUpdateIfDue({
  storage,
  installedVersion,
  fetchImpl = fetch,
  now = Date.now(),
  demoEnabled = false,
  demoTag = '',
}) {
  let cache = await readUpdateCache(storage);
  if (demoEnabled) return demoUpdate(installedVersion, demoTag, cache.demoDismissedTag);
  if (!shouldCheckForUpdate(cache.lastAttemptAt, now)) {
    return eligibleUpdate(cache.release, installedVersion, cache.dismissedTag);
  }

  // Persist before network so offline Settings visits cannot retry in a loop.
  cache = await writeUpdateCache(storage, { ...cache, lastAttemptAt: now });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetchImpl(UPDATE_CHECK_ENDPOINT, {
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'TubePulse-Android',
        ...(cache.etag ? { 'If-None-Match': cache.etag } : {}),
      },
      redirect: 'error',
      signal: controller.signal,
    });
    const responseEtag = response.headers?.get?.('etag');
    if (response.status === 304) {
      cache = await writeUpdateCache(storage, {
        ...cache,
        etag: isSafeEtag(responseEtag) ? responseEtag : cache.etag,
      });
    } else if (response.status === 200) {
      const contentType = response.headers?.get?.('content-type')?.split(';')[0]?.trim()?.toLowerCase();
      const declaredLength = Number(response.headers?.get?.('content-length'));
      if (contentType === 'application/json'
        && (!Number.isFinite(declaredLength) || declaredLength <= UPDATE_CHECK_MAX_BYTES)) {
        const body = await response.text();
        if (utf8Size(body) <= UPDATE_CHECK_MAX_BYTES) {
          const release = parseGitHubRelease(JSON.parse(body));
          if (release) {
            cache = await writeUpdateCache(storage, {
              ...cache,
              release,
              etag: isSafeEtag(responseEtag) ? responseEtag : null,
            });
          }
        }
      }
    }
  } catch { /* fail closed; retain any valid cached release */ } finally {
    clearTimeout(timer);
  }
  return eligibleUpdate(cache.release, installedVersion, cache.dismissedTag);
}

export async function dismissUpdate({ storage, tagName, demo = false }) {
  const cache = await readUpdateCache(storage);
  await writeUpdateCache(storage, {
    ...cache,
    ...(demo ? { demoDismissedTag: tagName } : { dismissedTag: tagName }),
  });
}
