const listeners = new Set();

export function notifyLocalSeenChanged() {
  for (const listener of listeners) {
    try { listener(); } catch { /* one screen listener must not block others */ }
  }
}

export function subscribeLocalSeenChanges(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
