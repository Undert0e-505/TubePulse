// Central safety policy for state that must not be copied between installations.
// The exact Firebase access token cache and WebSub leases are installation-bound.
export const DEFAULT_SYNC_EXCLUSIONS = Object.freeze([
  /^fcm:cache:token$/,
  /^fcm:lookup:/,
  /^channel:[^:]+:websub$/,
  /^gateway:canary:/,
]);

export function isSyncExcluded(key, patterns = DEFAULT_SYNC_EXCLUSIONS) {
  return patterns.some((pattern) => pattern.test(key));
}
