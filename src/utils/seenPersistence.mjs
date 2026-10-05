export const SEEN_MUTATION_QUEUE_KEY = 'tubepulse_seen_mutation_queue_v1';

const MAX_ATTEMPTS_EXPONENT = 6;
const BASE_RETRY_MS = 15_000;
const MAX_RETRY_MS = 15 * 60_000;
let queueMutex = Promise.resolve();

function withQueueLock(operation) {
  const running = queueMutex.then(operation, operation);
  queueMutex = running.catch(() => {});
  return running;
}

export function normalizeSeenContentIds(contentIds) {
  return [...new Set((Array.isArray(contentIds) ? contentIds : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean))];
}

function normalizeQueue(parsed) {
  const intents = Array.isArray(parsed?.intents) ? parsed.intents : [];
  return {
    schemaVersion: 1,
    intents: intents.map((intent) => ({
      channelId: String(intent?.channelId || ''),
      contentIds: normalizeSeenContentIds(intent?.contentIds),
      createdAt: Number(intent?.createdAt || 0),
      updatedAt: Number(intent?.updatedAt || 0),
      attempts: Math.max(0, Number(intent?.attempts || 0)),
      nextAttemptAt: Math.max(0, Number(intent?.nextAttemptAt || 0)),
      revision: Math.max(1, Number(intent?.revision || 1)),
    })).filter((intent) => intent.channelId && intent.contentIds.length),
  };
}

export async function readSeenMutationQueue(storage) {
  const raw = await storage.getItem(SEEN_MUTATION_QUEUE_KEY);
  if (!raw) return { schemaVersion: 1, intents: [] };
  try { return normalizeQueue(JSON.parse(raw)); }
  catch { return { schemaVersion: 1, intents: [] }; }
}

async function writeQueue(storage, queue) {
  await storage.setItem(SEEN_MUTATION_QUEUE_KEY, JSON.stringify(normalizeQueue(queue)));
}

export async function enqueueSeenMutation({ storage, channelId, contentIds, now = Date.now }) {
  const normalizedChannelId = String(channelId || '').trim();
  const normalizedIds = normalizeSeenContentIds(contentIds);
  if (!normalizedChannelId || !normalizedIds.length) return { queued: false, count: 0 };
  return await withQueueLock(async () => {
    const queue = await readSeenMutationQueue(storage);
    const existing = queue.intents.find((intent) => intent.channelId === normalizedChannelId);
    const timestamp = Number(now());
    if (existing) {
      existing.contentIds = normalizeSeenContentIds([...existing.contentIds, ...normalizedIds]);
      existing.updatedAt = timestamp;
      existing.nextAttemptAt = Math.min(existing.nextAttemptAt || timestamp, timestamp);
      existing.revision++;
    } else {
      queue.intents.push({
        channelId: normalizedChannelId,
        contentIds: normalizedIds,
        createdAt: timestamp,
        updatedAt: timestamp,
        attempts: 0,
        nextAttemptAt: timestamp,
        revision: 1,
      });
    }
    await writeQueue(storage, queue);
    return { queued: true, count: normalizedIds.length };
  });
}

function retryDelay(attempts) {
  return Math.min(MAX_RETRY_MS, BASE_RETRY_MS * (2 ** Math.min(MAX_ATTEMPTS_EXPONENT, attempts)));
}

export async function flushSeenMutationQueue({
  storage, deviceId, persist, now = Date.now, force = false, maxIntents = 20,
}) {
  if (!deviceId || typeof persist !== 'function') return { attempted: 0, confirmed: 0, remaining: null };
  let attempted = 0;
  let confirmed = 0;
  while (attempted < maxIntents) {
    const candidate = await withQueueLock(async () => {
      const queue = await readSeenMutationQueue(storage);
      const timestamp = Number(now());
      const intent = queue.intents.find((entry) => force || entry.nextAttemptAt <= timestamp);
      return intent ? { ...intent, contentIds: [...intent.contentIds] } : null;
    });
    if (!candidate) break;
    attempted++;
    let ok = false;
    try {
      const result = await persist(deviceId, candidate.channelId, candidate.contentIds, false);
      ok = result?.ok === true;
    } catch { /* retained below */ }
    await withQueueLock(async () => {
      const queue = await readSeenMutationQueue(storage);
      const current = queue.intents.find((intent) => intent.channelId === candidate.channelId);
      if (!current) return;
      if (ok) {
        const confirmedIds = new Set(candidate.contentIds);
        current.contentIds = current.contentIds.filter((id) => !confirmedIds.has(id));
        if (!current.contentIds.length) {
          queue.intents = queue.intents.filter((intent) => intent !== current);
        } else {
          current.attempts = 0;
          current.nextAttemptAt = Number(now());
        }
        confirmed++;
      } else {
        current.attempts++;
        current.updatedAt = Number(now());
        current.nextAttemptAt = current.updatedAt + retryDelay(current.attempts - 1);
      }
      await writeQueue(storage, queue);
    });
    if (!ok) break;
  }
  const remaining = (await readSeenMutationQueue(storage)).intents.length;
  return { attempted, confirmed, remaining };
}

export async function queueAndFlushSeenMutation(options) {
  const queued = await enqueueSeenMutation(options);
  if (!queued.queued) return { ...queued, attempted: 0, confirmed: 0 };
  const flushed = await flushSeenMutationQueue(options);
  return { ...queued, ...flushed };
}
