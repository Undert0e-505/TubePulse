export async function runSeenMutation({ persist, rollback }) {
  try {
    const result = await persist();
    if (result?.ok === true) return result;
    const error = new Error(result?.error || 'Server rejected seen status');
    error.status = result?.status;
    throw error;
  } catch (error) {
    try { await rollback(); } catch { /* preserve the server/network failure for the caller */ }
    return {
      ok: false,
      error: error?.message || 'Seen status could not be saved',
      ...(Number.isInteger(error?.status) ? { status: error.status } : {}),
    };
  }
}
