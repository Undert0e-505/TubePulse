/**
 * Collapse concurrent setup calls into one attempt while allowing a later call
 * to retry when that attempt fails. Successful setup remains valid for the
 * lifetime of the JS process.
 */
export function createRetryableAsyncSetup(setup) {
  let setupPromise = null;

  return function ensureSetup() {
    if (!setupPromise) {
      setupPromise = Promise.resolve()
        .then(setup)
        .catch((error) => {
          setupPromise = null;
          throw error;
        });
    }
    return setupPromise;
  };
}
