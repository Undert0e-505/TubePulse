export function createSettingsWarmCache({ readRaw, writeRaw, defaults }) {
  let snapshot = null;
  let loadPromise = null;
  let revision = 0;

  const copy = (value) => (value ? { ...value } : null);
  const normalize = (value) => ({ ...defaults, ...(value || {}) });

  function peek() {
    return copy(snapshot);
  }

  function preload() {
    if (snapshot) return Promise.resolve(copy(snapshot));
    if (loadPromise) return loadPromise;

    const loadRevision = revision;
    const pending = (async () => {
      const raw = await readRaw();
      let stored = raw ? JSON.parse(raw) : null;
      let needsPersistence = !stored;

      if (stored?.pollInterval && !stored.nagInterval) {
        stored = { ...stored, nagInterval: stored.pollInterval };
        delete stored.pollInterval;
        needsPersistence = true;
      }

      const loaded = normalize(stored);
      if (revision !== loadRevision) return copy(snapshot);

      snapshot = loaded;
      if (needsPersistence && revision === loadRevision) {
        await writeRaw(JSON.stringify(loaded));
      }
      return copy(snapshot);
    })();
    loadPromise = pending;
    pending.catch(() => {
      if (loadPromise === pending) loadPromise = null;
    });

    return pending;
  }

  function save(value) {
    revision += 1;
    snapshot = normalize(value);
    loadPromise = Promise.resolve(copy(snapshot));
    const serialized = JSON.stringify(value);
    return writeRaw(serialized);
  }

  return { peek, preload, save };
}
