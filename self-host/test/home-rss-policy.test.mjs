import assert from 'node:assert/strict';
import test from 'node:test';
import {
  balancedRssCohorts,
  deterministicRssOrder,
  fallbackChannelsForMinute,
  fallbackQuotaPlan,
  pacificQuotaWindow,
  rssCohortForMinute,
  sameFleetOutage,
  normalizeRssHealthState,
  rssNextMinuteSchedule,
  validateIndependentRssProbe,
} from '../src/home-rss-policy.mjs';
import {
  adaptPlaylistItems,
  fetchUploadsPlaylist,
  uploadsPlaylistId,
} from '../src/youtube-api-fallback.mjs';

function channels(count) {
  return Array.from({ length: count }, (_, index) => `UC${String(index).padStart(22, '0')}`);
}

test('deterministic five-minute cohorts cover each unique channel once and remain balanced for fleets 1..100', () => {
  for (let count = 1; count <= 100; count++) {
    const active = channels(count);
    const cohorts = balancedRssCohorts([...active, active[0]], 2_345);
    const covered = cohorts.flat();
    assert.equal(covered.length, count, `coverage length for ${count}`);
    assert.deepEqual([...covered].sort(), active, `exact coverage for ${count}`);
    assert.equal(new Set(covered).size, count, `unique coverage for ${count}`);
    const sizes = cohorts.map((cohort) => cohort.length);
    assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1, `balanced cohorts for ${count}`);
  }
});

test('RSS order is restart reproducible and changes on the next cycle', () => {
  const active = channels(85);
  assert.deepEqual(deterministicRssOrder(active, 1000), deterministicRssOrder(active, 1000));
  assert.notDeepEqual(deterministicRssOrder(active, 1000), deterministicRssOrder(active, 1001));
  const start = Date.UTC(2026, 9, 5, 12, 0);
  const covered = [];
  for (let minute = 0; minute < 5; minute++) covered.push(...rssCohortForMinute(active, start + minute * 60_000).channels);
  assert.deepEqual([...covered].sort(), active);
});

test('fleet outage requires one same-class failure for every active channel', () => {
  assert.equal(sameFleetOutage([
    { outcome: 'error', errorCategory: 'http-404' },
    { outcome: 'error', errorCategory: 'http-404' },
  ], 2), 'http-404');
  assert.equal(sameFleetOutage([
    { outcome: 'error', errorCategory: 'http-404' },
    { outcome: 'ok' },
  ], 2), null);
  assert.equal(sameFleetOutage([
    { outcome: 'error', errorCategory: 'http-404' },
    { outcome: 'error', errorCategory: 'timeout' },
  ], 2), null);
  assert.equal(sameFleetOutage([{ outcome: 'error', errorCategory: 'http-404' }], 2), null);
});

test('fallback cadence never exceeds two channels per minute and respects the combined quota reserve', () => {
  const active = channels(85);
  const plan = fallbackQuotaPlan({
    channelCount: active.length,
    dailyQuotaUnits: 10_000,
    reserveUnits: 1_000,
    postsCadenceMinutes: 60,
  });
  assert.equal(plan.postsProjection, 2_040);
  assert.equal(plan.dailyCap, 6_960);
  assert.equal(plan.coverageMinutes, 60);
  const epochStart = Math.floor(Date.UTC(2026, 9, 5, 12, 0) / (plan.coverageMinutes * 60_000))
    * plan.coverageMinutes * 60_000;
  const seen = [];
  for (let minute = 0; minute < plan.coverageMinutes; minute++) {
    const selected = fallbackChannelsForMinute(active, epochStart + minute * 60_000, plan.coverageMinutes);
    assert.ok(selected.length <= 2);
    seen.push(...selected);
  }
  assert.deepEqual([...seen].sort(), active);

  const constrained = fallbackQuotaPlan({
    channelCount: active.length,
    dailyQuotaUnits: 3_200,
    reserveUnits: 1_000,
    postsCadenceMinutes: 60,
  });
  assert.ok(constrained.coverageMinutes > 60);
  assert.ok(constrained.projectedDailyRequests <= constrained.dailyCap);
});

test('Pacific quota windows use midnight America/Los_Angeles and handle both DST boundary lengths', () => {
  const spring = pacificQuotaWindow(Date.parse('2026-03-08T12:00:00.000Z'));
  assert.equal(spring.day, '2026-03-08');
  assert.equal(spring.startedAt, '2026-03-08T08:00:00.000Z');
  assert.equal(spring.resetsAt, '2026-03-09T07:00:00.000Z');
  assert.equal(spring.durationHours, 23);

  const fall = pacificQuotaWindow(Date.parse('2026-11-01T12:00:00.000Z'));
  assert.equal(fall.day, '2026-11-01');
  assert.equal(fall.startedAt, '2026-11-01T07:00:00.000Z');
  assert.equal(fall.resetsAt, '2026-11-02T08:00:00.000Z');
  assert.equal(fall.durationHours, 25);
});

test('playlist fallback derives the uploads playlist and adapts entries without synthetic metrics', () => {
  const channelId = 'UC_x5XG1OV2P6uZZ5FSM9Ttw';
  assert.equal(uploadsPlaylistId(channelId), 'UU_x5XG1OV2P6uZZ5FSM9Ttw');
  const adapted = adaptPlaylistItems({ items: [{
    snippet: {
      title: 'Upload', publishedAt: '2026-10-05T01:02:03.000Z',
      videoOwnerChannelTitle: 'Official', resourceId: { videoId: 'abcdefghijk' },
      thumbnails: { high: { url: 'https://example.test/thumb.jpg' } },
    },
    contentDetails: { videoId: 'abcdefghijk', videoPublishedAt: '2026-10-05T01:02:03.000Z' },
  }] });
  assert.equal(adapted.channelName, 'Official');
  assert.deepEqual(adapted.uploads[0], {
    videoId: 'abcdefghijk', title: 'Upload', published: '2026-10-05T01:02:03.000Z',
    thumbnail: 'https://example.test/thumb.jpg', link: 'https://www.youtube.com/watch?v=abcdefghijk',
    channelTitle: 'Official', views: null, likes: null, dislikes: null,
  });
});

test('playlist fallback uses playlistItems.list once, never search.list, and bounds errors', async () => {
  let requested;
  const source = await fetchUploadsPlaylist('UC_x5XG1OV2P6uZZ5FSM9Ttw', {
    apiKey: 'secret-key',
    fetchImpl: async (url) => {
      requested = new URL(url);
      return Response.json({ items: [] });
    },
  });
  assert.deepEqual(source.uploads, []);
  assert.equal(requested.pathname, '/youtube/v3/playlistItems');
  assert.equal(requested.searchParams.get('playlistId'), 'UU_x5XG1OV2P6uZZ5FSM9Ttw');
  assert.equal(requested.searchParams.get('maxResults'), '15');
  assert.equal(requested.pathname.includes('search'), false);
  await assert.rejects(
    () => fetchUploadsPlaylist('UC_x5XG1OV2P6uZZ5FSM9Ttw', {
      apiKey: 'secret-key', fetchImpl: async () => new Response('{}', { status: 403 }),
    }),
    (error) => error.category === 'quota-or-forbidden' && error.status === 403,
  );
});

test('minute scheduling tolerates at most five seconds of confirmation skew outside any tick lease', () => {
  const now = Date.parse('2026-10-05T12:04:10Z');
  const boundary = Date.parse('2026-10-05T12:05:00Z');
  assert.deepEqual(rssNextMinuteSchedule(now, '2026-10-05T12:05:03Z'), { scheduledTime: boundary, runAt: boundary + 3000 });
  assert.deepEqual(rssNextMinuteSchedule(now, '2026-10-05T12:05:06Z'), { scheduledTime: boundary, runAt: boundary });
  assert.equal(rssNextMinuteSchedule(now, null).runAt, boundary);
});

test('old inconclusive circuit migrates to fresh prompt confirmation without carrying outage certainty', () => {
  const now = Date.parse('2026-10-05T12:00:00Z');
  const health = normalizeRssHealthState({
    sourceMode: 'rss-probe-inconclusive', circuit: { open: true, until: '2026-10-05T13:00:00Z' },
    independentProbe: { outcome: 'inconclusive' }, fallback: { quotaUsed: 42, requests: 42 },
  }, now);
  assert.equal(health.policyVersion, 2);
  assert.equal(health.independentProbe.unavailableStreak, 0);
  assert.equal(health.independentProbe.confirmationPending, true);
  assert.equal(Date.parse(health.independentProbe.nextConfirmationAt), now);
  assert.equal(Date.parse(health.circuit.until), now);
  assert.equal(health.fallback.quotaUnitsUsed, 42);
  health.independentProbe.unavailableStreak = 1;
  health.independentProbe.nextConfirmationAt = '2026-10-05T12:01:00Z';
  assert.deepEqual(normalizeRssHealthState(health, now + 1000), health, 'new state must not migrate again after restart');
});

test('independent evidence requires exact bounded labels and consistent terminal classifications', () => {
  const channel = channels(1)[0];
  const terminal = (classification, status) => ({ ok: true, outcome: 'failure', probes: ['official', 'active'].map((label) => ({
    label, classification, status, validXml: false,
  })) });
  for (const [classification, status] of [['network', null], ['timeout', null], ['redirect', 302], ['http-404', 404], ['invalid-xml', 200], ['response-too-large', 200]]) {
    assert.equal(validateIndependentRssProbe(terminal(classification, status), channel).outcome, 'failure');
  }
  for (const bad of [null, {}, { outcome: 'failure', probes: [] }, terminal('network', 200), terminal('http-200', 200), terminal('redirect', null), terminal('unknown', null)]) {
    assert.equal(validateIndependentRssProbe(bad, channel).outcome, 'inconclusive');
  }
  const bad = terminal('network', null);
  bad.probes[1].label = 'official';
  assert.equal(validateIndependentRssProbe(bad, channel).outcome, 'inconclusive');
  const mixed = terminal('network', null);
  mixed.probes[1] = { label: 'active', status: 200, classification: 'valid-feed', validXml: true };
  assert.equal(validateIndependentRssProbe(mixed, channel).outcome, 'inconclusive', 'contradictory outcome fails safe');
  mixed.outcome = 'success';
  assert.equal(validateIndependentRssProbe(mixed, channel).outcome, 'success');
});

test('growing fleets slow automatically; configured budgets cannot lift the hard 10000 limits or reserve', () => {
  for (const count of [85, 121, 200, 250, 300]) {
    const plan = fallbackQuotaPlan({ channelCount: count, dailyQuotaUnits: 50_000, reserveUnits: 0, postsCadenceMinutes: 60 });
    assert.ok(plan.reserveUnits >= 1000);
    assert.ok(plan.requestLimit <= 10_000 && plan.quotaUnitLimit <= 10_000);
    assert.ok(plan.projectedDailyRequests <= plan.dailyCap);
    if (count > 120) assert.ok(plan.coverageMinutes > 60);
    const fleet = channels(count);
    for (let minute = 0; minute < plan.coverageMinutes; minute++) {
      assert.ok(fallbackChannelsForMinute(fleet, minute * 60_000, plan.coverageMinutes).length <= 2);
    }
  }
});

test('API fallback bounds oversized, invalid, rejected and hanging body responses without leaking source text', async () => {
  const channel = channels(1)[0];
  for (const [category, fetchImpl] of [
    ['network', async () => { throw new Error('secret-key source body'); }],
    ['invalid-response', async () => new Response('secret-key source body')],
    ['response-too-large', async () => new Response('x'.repeat(100))],
    ['timeout', async () => new Response(new ReadableStream({ start() {} }))],
  ]) {
    // Keep a referenced timer alive: production's listener does the same.
    const alive = setTimeout(() => {}, 1000);
    try {
      await assert.rejects(() => fetchUploadsPlaylist(channel, { apiKey: 'secret-key', timeoutMs: 20, maxResponseBytes: 50, fetchImpl }),
        (error) => error.category === category && !error.message.includes('secret-key'));
    } finally { clearTimeout(alive); }
  }
});
