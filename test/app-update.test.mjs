import assert from 'node:assert/strict';
import test from 'node:test';
import {
  UPDATE_CACHE_KEY,
  UPDATE_CHECK_INTERVAL_MS,
  cachedAvailableUpdate,
  dismissUpdate,
  parseGitHubRelease,
  parseStableVersion,
  refreshUpdateIfDue,
  validateReleaseUrl,
} from '../src/utils/appUpdate.mjs';
import { updatePillAnimationDecision } from '../src/utils/updatePillAnimation.mjs';

function memoryStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: async (key) => map.get(key) ?? null,
    setItem: async (key, value) => { map.set(key, value); },
    value: (key) => map.get(key),
  };
}

function release(tag = 'v4.0.1') {
  return {
    draft: false,
    prerelease: false,
    tag_name: tag,
    html_url: `https://github.com/Undert0e-505/TubePulse/releases/tag/${tag}`,
  };
}

test('stable semver and exact release URL validation fail closed', () => {
  assert.deepEqual(parseStableVersion('v4.0.1'), { major: 4, minor: 0, patch: 1 });
  for (const invalid of ['4.0', '4.0.1-beta', 'v04.0.1', ' 4.0.1']) assert.equal(parseStableVersion(invalid), null);
  assert.equal(validateReleaseUrl('v4.0.1', release().html_url), release().html_url);
  for (const url of [
    'http://github.com/Undert0e-505/TubePulse/releases/tag/v4.0.1',
    'https://evil.example/Undert0e-505/TubePulse/releases/tag/v4.0.1',
    'https://user@github.com/Undert0e-505/TubePulse/releases/tag/v4.0.1',
    'https://github.com:444/Undert0e-505/TubePulse/releases/tag/v4.0.1',
    'https://github.com/Undert0e-505/TubePulse/releases/tag/v4.0.1?q=1',
    'https://github.com/Undert0e-505/TubePulse/releases/tag/v4.0.1#x',
  ]) assert.equal(validateReleaseUrl('v4.0.1', url), null);
  assert.equal(parseGitHubRelease({ ...release(), draft: true }), null);
  assert.equal(parseGitHubRelease({ ...release(), prerelease: true }), null);
});

test('refresh records attempt, caches ETag and enforces twelve-hour cadence', async () => {
  const storage = memoryStorage();
  let calls = 0;
  const fetchImpl = async (_url, init) => {
    calls++;
    assert.equal(init.headers.Accept, 'application/vnd.github+json');
    assert.equal(init.headers['X-GitHub-Api-Version'], '2022-11-28');
    assert.equal(init.headers['User-Agent'], 'TubePulse-Android');
    assert.equal(init.redirect, 'error');
    return new Response(JSON.stringify(release()), {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8', etag: '"safe"' },
    });
  };
  const first = await refreshUpdateIfDue({ storage, installedVersion: '4.0.0', fetchImpl, now: 1000 });
  assert.equal(first.tagName, 'v4.0.1');
  assert.equal(calls, 1);
  await refreshUpdateIfDue({ storage, installedVersion: '4.0.0', fetchImpl, now: 1000 + UPDATE_CHECK_INTERVAL_MS - 1 });
  assert.equal(calls, 1);
  const cached = JSON.parse(storage.value(UPDATE_CACHE_KEY));
  assert.equal(cached.etag, '"safe"');
});

test('304 reuses cache and offline attempt remains rate limited', async () => {
  const cache = {
    lastAttemptAt: 1,
    etag: '"old"',
    release: { tagName: 'v4.0.1', releaseUrl: release().html_url },
  };
  const storage = memoryStorage({ [UPDATE_CACHE_KEY]: JSON.stringify(cache) });
  let header;
  const updated = await refreshUpdateIfDue({
    storage, installedVersion: '4.0.0', now: UPDATE_CHECK_INTERVAL_MS + 2,
    fetchImpl: async (_url, init) => {
      header = init.headers['If-None-Match'];
      return new Response(null, { status: 304, headers: { etag: '"new"' } });
    },
  });
  assert.equal(header, '"old"');
  assert.equal(updated.tagName, 'v4.0.1');

  let calls = 0;
  await refreshUpdateIfDue({
    storage, installedVersion: '4.0.0', now: 2 * UPDATE_CHECK_INTERVAL_MS + 3,
    fetchImpl: async () => { calls++; throw new Error('offline'); },
  });
  await refreshUpdateIfDue({
    storage, installedVersion: '4.0.0', now: 2 * UPDATE_CHECK_INTERVAL_MS + 4,
    fetchImpl: async () => { calls++; throw new Error('offline'); },
  });
  assert.equal(calls, 1);
  assert.equal((await cachedAvailableUpdate({ storage, installedVersion: '4.0.0' })).tagName, 'v4.0.1');
});

test('dismissal is exact, newer releases reappear, and demo dismissal is isolated', async () => {
  const storage = memoryStorage({
    [UPDATE_CACHE_KEY]: JSON.stringify({
      release: { tagName: 'v4.0.1', releaseUrl: release().html_url },
    }),
  });
  await dismissUpdate({ storage, tagName: 'v4.0.1' });
  assert.equal(await cachedAvailableUpdate({ storage, installedVersion: '4.0.0' }), null);

  const nextRelease = release('v4.0.2');
  await refreshUpdateIfDue({
    storage, installedVersion: '4.0.0', now: UPDATE_CHECK_INTERVAL_MS + 1,
    fetchImpl: async () => new Response(JSON.stringify(nextRelease), {
      status: 200, headers: { 'content-type': 'application/json' },
    }),
  });
  assert.equal((await cachedAvailableUpdate({ storage, installedVersion: '4.0.0' })).tagName, 'v4.0.2');

  await dismissUpdate({ storage, tagName: 'v4.0.9', demo: true });
  assert.equal((await cachedAvailableUpdate({ storage, installedVersion: '4.0.0' })).tagName, 'v4.0.2');
  assert.equal(await cachedAvailableUpdate({
    storage, installedVersion: '4.0.0', demoEnabled: true, demoTag: 'v4.0.9',
  }), null);
});

test('oversize, malformed and prerelease responses do not replace valid cache', async () => {
  const storage = memoryStorage({
    [UPDATE_CACHE_KEY]: JSON.stringify({
      release: { tagName: 'v4.0.1', releaseUrl: release().html_url },
    }),
  });
  await refreshUpdateIfDue({
    storage, installedVersion: '4.0.0', now: 100,
    fetchImpl: async () => new Response('x', {
      status: 200, headers: { 'content-type': 'application/json', 'content-length': '65537' },
    }),
  });
  assert.equal((await cachedAvailableUpdate({ storage, installedVersion: '4.0.0' })).tagName, 'v4.0.1');
});

test('update pill waits for motion preference before handling the first Settings visit', () => {
  const base = { hasUpdate: true, visitId: 1, handledVisitId: -1 };
  assert.equal(updatePillAnimationDecision({
    ...base, preferenceReady: false, reduceMotion: true,
  }), 'wait');
  assert.equal(updatePillAnimationDecision({
    ...base, preferenceReady: true, reduceMotion: false,
  }), 'animate');
  assert.equal(updatePillAnimationDecision({
    ...base, preferenceReady: true, reduceMotion: true,
  }), 'settle');
  assert.equal(updatePillAnimationDecision({
    ...base, handledVisitId: 1, preferenceReady: true, reduceMotion: false,
  }), 'none');
});
