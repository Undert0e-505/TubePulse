import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PRECISE_LIVE_WATCH_AFTER_MS,
  PRECISE_LIVE_WATCH_BEFORE_MS,
  advanceCancellationObservation,
  chunkLiveWatchEvents,
  classifyPublicLiveObservation,
  liveWatchRequestPriority,
  nextTenSecondBoundary,
  normalizePreciseLiveWatchState,
  planPreciseLiveWatch,
  publicPreciseLiveWatchState,
  shouldRunPreciseLiveWatchCycle,
} from '../src/precise-live-watch.mjs';

const start = Date.parse('2026-10-09T18:00:00Z');
const event = { channelId: 'channel-redacted', videoId: 'video-redacted', scheduledFor: start };

test('precision window arms exactly at T-5 and remains inclusive through T+15', () => {
  const state = normalizePreciseLiveWatchState(null, start);
  assert.equal(planPreciseLiveWatch([event], state, start - PRECISE_LIVE_WATCH_BEFORE_MS - 1).due.length, 0);
  assert.equal(planPreciseLiveWatch([event], state, start - PRECISE_LIVE_WATCH_BEFORE_MS).due.length, 1);
  assert.equal(planPreciseLiveWatch([event], state, start + PRECISE_LIVE_WATCH_AFTER_MS).due.length, 1);
  assert.equal(planPreciseLiveWatch([event], state, start + PRECISE_LIVE_WATCH_AFTER_MS + 1).due.length, 0);
});

test('precision cadence is ten seconds and timeout falls back only on ordinary detector ticks', () => {
  const state = normalizePreciseLiveWatchState({ watchers: {
    [event.videoId]: { lastPolledAt: new Date(start - 4 * 60_000).toISOString() },
  } }, start);
  assert.equal(planPreciseLiveWatch([event], state, start - 4 * 60_000 + 9_999).due.length, 0);
  assert.equal(planPreciseLiveWatch([event], state, start - 4 * 60_000 + 10_000).due.length, 1);
  const late = start + PRECISE_LIVE_WATCH_AFTER_MS + 60_000;
  assert.equal(planPreciseLiveWatch([event], state, late).due.length, 0);
  assert.equal(planPreciseLiveWatch([event], state, late, { ordinaryFallback: true }).due.length, 1);
});

test('live confirmation accepts actual start or public live state, never active chat alone', () => {
  const actualStart = classifyPublicLiveObservation({
    snippet: { liveBroadcastContent: 'upcoming' },
    liveStreamingDetails: { actualStartTime: '2026-10-09T17:56:00Z' },
  }, event);
  assert.equal(actualStart.outcome, 'live', 'four-minute-early actual start is live');
  assert.equal(actualStart.triggerReason, 'actual-start-time');
  const broadcast = classifyPublicLiveObservation({
    snippet: { liveBroadcastContent: 'live' }, liveStreamingDetails: {},
  }, event);
  assert.equal(broadcast.outcome, 'live');
  assert.equal(broadcast.triggerReason, 'live-broadcast-content');
  assert.equal(classifyPublicLiveObservation({
    snippet: { liveBroadcastContent: 'live' },
    liveStreamingDetails: { actualStartTime: '2026-10-09T17:56:00Z' },
  }, event).triggerReason, 'both');
  assert.equal(classifyPublicLiveObservation({
    snippet: { liveBroadcastContent: 'upcoming' },
    status: { privacyStatus: 'public' },
    liveStreamingDetails: {
      scheduledStartTime: new Date(start).toISOString(),
      activeLiveChatId: 'chat-open-early',
    },
  }, event).outcome, 'upcoming');
});

test('fourteen-minute-late live start is confirmed within the precision window', () => {
  const late = start + 14 * 60_000;
  assert.equal(planPreciseLiveWatch([event], normalizePreciseLiveWatchState(null, late), late).due.length, 1);
  assert.equal(classifyPublicLiveObservation({
    snippet: { liveBroadcastContent: 'upcoming' },
    liveStreamingDetails: { actualStartTime: new Date(late).toISOString() },
  }, event).outcome, 'live');
});

test('reschedules in either direction return the new authoritative anchor', () => {
  for (const delta of [-30 * 60_000, 45 * 60_000]) {
    const next = start + delta;
    const result = classifyPublicLiveObservation({
      snippet: { liveBroadcastContent: 'upcoming' },
      status: { privacyStatus: 'public' },
      liveStreamingDetails: { scheduledStartTime: new Date(next).toISOString() },
    }, event);
    assert.deepEqual(result, { outcome: 'rescheduled', scheduledStartTime: next });
  }
});

test('public terminal and cancellation-like observations are distinguished', () => {
  assert.equal(classifyPublicLiveObservation({
    snippet: { liveBroadcastContent: 'none' },
    liveStreamingDetails: {
      actualStartTime: '2026-10-09T18:01:00Z',
      actualEndTime: '2026-10-09T18:30:00Z',
    },
  }, event).outcome, 'completed');
  assert.equal(classifyPublicLiveObservation(null, event).reason, 'missing-item');
  assert.equal(classifyPublicLiveObservation({ status: { privacyStatus: 'private' } }, event).reason, 'not-public');
  assert.equal(classifyPublicLiveObservation({ status: { uploadStatus: 'deleted' } }, event).reason, 'terminal-upload-status');
  assert.equal(classifyPublicLiveObservation({ snippet: { liveBroadcastContent: 'none' } }, event).reason, 'lost-upcoming-metadata');
});

test('cancellation requires two successful signals and API failure does not advance it', () => {
  const first = advanceCancellationObservation({}, { outcome: 'cancellation-like' });
  assert.equal(first.terminal, false);
  assert.equal(first.watcher.consecutiveCancellation, 1);
  const failed = advanceCancellationObservation(first.watcher, { outcome: 'api-error' });
  assert.equal(failed.terminal, false);
  assert.equal(failed.watcher.consecutiveCancellation, 1);
  const second = advanceCancellationObservation(failed.watcher, { outcome: 'cancellation-like' });
  assert.equal(second.terminal, true);
  assert.equal(second.watcher.consecutiveCancellation, 2);
  const recovered = advanceCancellationObservation(first.watcher, { outcome: 'upcoming' });
  assert.equal(recovered.watcher.consecutiveCancellation, 0);
});

test('live watcher batches public video IDs at the YouTube maximum', () => {
  assert.deepEqual(chunkLiveWatchEvents(Array.from({ length: 1 }), 50).map((batch) => batch.length), [1]);
  assert.deepEqual(chunkLiveWatchEvents(Array.from({ length: 50 }), 50).map((batch) => batch.length), [50]);
  assert.deepEqual(chunkLiveWatchEvents(Array.from({ length: 51 }), 50).map((batch) => batch.length), [50, 1]);
});

test('watch quota persists within and resets at Pacific midnight', () => {
  const before = Date.parse('2026-03-09T06:59:59Z');
  const after = Date.parse('2026-03-09T07:00:00Z');
  const state = normalizePreciseLiveWatchState(null, before);
  state.quota.units = 120;
  assert.equal(normalizePreciseLiveWatchState(state, before).quota.units, 120);
  assert.equal(normalizePreciseLiveWatchState(state, after).quota.units, 0);
});

test('precision cap degrades only aligned fallback checks to the ordinary quota path', () => {
  assert.equal(liveWatchRequestPriority({
    ordinaryFallback: false, precisionUnits: 2_000, precisionDailyCap: 2_000,
  }), 'live-watch');
  assert.equal(liveWatchRequestPriority({
    ordinaryFallback: true, precisionUnits: 1_999, precisionDailyCap: 2_000,
  }), 'live-watch');
  assert.equal(liveWatchRequestPriority({
    ordinaryFallback: true, precisionUnits: 2_000, precisionDailyCap: 2_000,
  }), 'scheduled-live-fallback');
});

test('public watcher state never exposes per-video watcher identifiers', () => {
  const state = normalizePreciseLiveWatchState({ watchers: {
    'sensitive-video-id': { lastPolledAt: new Date(start).toISOString(), consecutiveCancellation: 1 },
  }, activeWatcherCount: 1 }, start);
  const publicState = publicPreciseLiveWatchState(state, start);
  assert.equal(publicState.activeWatcherCount, 1);
  assert.equal(Object.hasOwn(publicState, 'watchers'), false);
  assert.equal(Object.hasOwn(publicState, 'nextWindowAt'), false);
  assert.equal(publicState.lastTriggerReason, null);
  assert.equal(JSON.stringify(publicState).includes('sensitive-video-id'), false);
});

test('public watcher audit retains only the normalized live trigger reason', () => {
  const publicState = publicPreciseLiveWatchState({
    lastTriggerReason: 'both',
    watchers: { 'sensitive-video-id': { trigger: 'raw-response' } },
  }, start);
  assert.equal(publicState.lastTriggerReason, 'both');
  assert.equal(JSON.stringify(publicState).includes('sensitive-video-id'), false);
  assert.equal(publicPreciseLiveWatchState({ lastTriggerReason: 'unexpected' }, start).lastTriggerReason, null);
});

test('ten-second timer scheduling advances to the next strict boundary', () => {
  assert.equal(nextTenSecondBoundary(start), start + 10_000);
  assert.equal(nextTenSecondBoundary(start + 1), start + 10_000);
  assert.equal(nextTenSecondBoundary(start + 9_999), start + 10_000);
});

test('the ten-second watcher is the only precision owner between aligned detector ticks', () => {
  assert.equal(shouldRunPreciseLiveWatchCycle({ preciseLiveOnly: true, scheduledTime: start + 60_000 }), true);
  assert.equal(shouldRunPreciseLiveWatchCycle({ preciseLiveOnly: false, scheduledTime: start }), true);
  assert.equal(shouldRunPreciseLiveWatchCycle({ preciseLiveOnly: false, scheduledTime: start + 60_000 }), false);
  assert.equal(shouldRunPreciseLiveWatchCycle({ preciseLiveOnly: false, scheduledTime: start + 5 * 60_000 }), true);
});
