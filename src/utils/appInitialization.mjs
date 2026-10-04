export const APP_INITIALIZATION_STORAGE_KEY = 'tubepulse_init_done';
export const APP_SESSION_STARTED_AT = Date.now();

let initializationMarkerSequence = 0;

/**
 * Return a marker unique to one mounted application initialization cycle.
 *
 * A process-level timestamp alone is not enough: changing Preview servers
 * remounts TubePulseApplication without restarting JavaScript, so a marker
 * written by the previous mount could otherwise release the new Home early.
 */
export function createAppInitializationMarker({
  now = () => Date.now(),
  random = () => Math.random(),
} = {}) {
  initializationMarkerSequence += 1;
  const randomPart = Math.floor(random() * 0x100000000).toString(36);
  return `${now().toString(36)}-${initializationMarkerSequence.toString(36)}-${randomPart}`;
}

export function isCurrentInitializationComplete(value, notBefore = APP_SESSION_STARTED_AT) {
  const completedAt = Number(value);
  return Number.isFinite(completedAt) && completedAt >= notBefore;
}

export function isExpectedInitializationComplete(value, expectedMarker) {
  return typeof expectedMarker === 'string'
    && expectedMarker.length > 0
    && value === expectedMarker;
}

export function getPreviewHomeConnectionPhase({ initializationPending, connectionError }) {
  if (initializationPending) return 'connecting';
  if (connectionError) return 'error';
  return 'ready';
}

/**
 * Wait for the current app session's initialization marker. Persisted markers
 * from an earlier process do not count, which prevents Home from racing a new
 * registration after an upgrade or server change.
 */
export async function waitForCurrentInitialization({
  readCompletion,
  expectedMarker = null,
  notBefore = APP_SESSION_STARTED_AT,
  maxAttempts = 31,
  pollIntervalMs = 500,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  if (typeof readCompletion !== 'function') {
    throw new TypeError('readCompletion is required');
  }

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const value = await readCompletion();
    const complete = expectedMarker
      ? isExpectedInitializationComplete(value, expectedMarker)
      : isCurrentInitializationComplete(value, notBefore);
    if (complete) return true;
    if (attempt + 1 < maxAttempts) await sleep(pollIntervalMs);
  }

  return false;
}
