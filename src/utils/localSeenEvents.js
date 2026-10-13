const listeners = new Set();

export function notifyLocalSeenChanged(change = null) {
  for (const listener of listeners) {
    try { listener(change); } catch { /* one screen listener must not block others */ }
  }
}

export function subscribeLocalSeenChanges(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
