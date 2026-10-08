import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { HomeSchedulerRunner, createHomeSchedulerStateFile } from '../src/home-scheduler.mjs';
import {
  YouTubeDataApiClient,
  chunked,
  fetchPlaylistReconciliation,
  metricCadenceMinutes,
  normalizeStatistics,
  normalizeYoutubeDataApiState,
  pacificQuotaWindow,
  pruneMetricPollToVisibleVideos,
  selectDueMetricVideos,
  updateMetricPollObservation,
} from '../src/youtube-data-api.mjs';
import { classifyRssVideosForNotification } from '../../worker/tubepulse-cron/shared.mjs';

function response(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
}

test('85 channels are split into exactly two 50-ID detector calls with partial fields', async () => {
  const calls = [];
  const reservations = [];
  const api = new YouTubeDataApiClient({
    apiKey: 'not-a-secret',
    reserve: async (...args) => reservations.push(args),
    fetchImpl: async (url) => { calls.push(new URL(url)); return response({ items: [] }); },
  });
  const channels = Array.from({ length: 85 }, (_, index) => `UC${String(index).padStart(22, '0')}`);
  for (const ids of chunked(channels, 50)) await api.listChannels(ids);
  assert.deepEqual(calls.map((url) => url.searchParams.get('id').split(',').length), [50, 35]);
  assert.ok(calls.every((url) => url.searchParams.get('part') === 'statistics,contentDetails'));
  assert.ok(calls.every((url) => !url.searchParams.get('fields').includes('snippet')));
  assert.deepEqual(reservations, [['general', 1, 'detector'], ['general', 1, 'detector']]);
  assert.ok(calls.every((url) => !url.pathname.includes('search')));
});

test('playlist reconciliation stops at known overlap and bounds no-overlap pagination', async () => {
  const pages = [];
  const api = {
    async listPlaylistItems(_playlistId, token) {
      pages.push(token);
      const page = token ? Number(token) : 1;
      return {
        nextPageToken: page < 5 ? String(page + 1) : null,
        items: [{
          snippet: { title: `Video ${page}`, publishedAt: `2026-10-0${page}T00:00:00Z`, resourceId: { videoId: `videoid0000${page}` } },
          contentDetails: { videoId: `videoid0000${page}`, videoPublishedAt: `2026-10-0${page}T00:00:00Z` },
          status: { privacyStatus: 'public' },
        }],
      };
    },
    async listVideoDetails(ids) {
      return { items: ids.map((id) => ({
        id, snippet: { title: id, publishedAt: '2026-10-01T00:00:00Z', thumbnails: {} },
        status: { privacyStatus: 'public' },
      })) };
    },
  };
  const overlap = await fetchPlaylistReconciliation({ api, playlistId: 'UUx', knownIds: ['videoid00002'], maximumPages: 3 });
  assert.equal(overlap.pageCount, 2);
  assert.equal(overlap.overlap, true);
  pages.length = 0;
  const bounded = await fetchPlaylistReconciliation({ api, playlistId: 'UUx', knownIds: ['not-present'], maximumPages: 3 });
  assert.equal(bounded.pageCount, 3);
  assert.equal(bounded.truncatedWithoutOverlap, true);
});

test('private, deleted and missing videos are excluded and optional statistics remain null', async () => {
  const api = {
    async listPlaylistItems() {
      return { items: [
        { snippet: { title: 'Deleted video', publishedAt: '2026-10-01T00:00:00Z' }, contentDetails: { videoId: 'deleted00001' }, status: { privacyStatus: 'public' } },
        { snippet: { title: 'Private', publishedAt: '2026-10-01T00:00:00Z' }, contentDetails: { videoId: 'private00001' }, status: { privacyStatus: 'private' } },
        { snippet: { title: 'Available', publishedAt: '2026-10-01T00:00:00Z' }, contentDetails: { videoId: 'public000001' }, status: { privacyStatus: 'public' } },
      ] };
    },
    async listVideoDetails() { return { items: [] }; },
  };
  const result = await fetchPlaylistReconciliation({ api, playlistId: 'UUx', knownIds: ['public000001'] });
  assert.deepEqual(result.uploads.map((item) => item.videoId), ['public000001']);
  const metrics = normalizeStatistics({ items: [{ id: 'public000001', statistics: { viewCount: '9' } }] });
  assert.deepEqual(metrics.get('public000001'), { views: '9', likes: null, comments: null, dislikes: null });
});

test('metric selection is limited to the visible top three and prunes older polling state', () => {
  const now = Date.parse('2026-10-05T12:00:00Z');
  const videos = [[
    'UC0000000000000000000000',
    [
      { videoId: 'newest00001', publishedAt: '2026-10-05T11:00:00Z' },
      { videoId: 'weekold0001', publishedAt: '2026-09-30T00:00:00Z' },
      { videoId: 'oldstatic01', publishedAt: '2026-01-01T00:00:00Z' },
      { videoId: 'fourth00001', publishedAt: '2025-01-01T00:00:00Z' },
    ],
  ]];
  const poll = {
    newest00001: { lastPolledAt: '2026-10-05T11:54:00Z' },
    weekold0001: { lastPolledAt: '2026-10-05T11:44:00Z' },
    oldstatic01: { lastPolledAt: '2026-10-05T00:01:00Z', staticStreak: 4 },
    fourth00001: { lastPolledAt: '2026-10-05T11:59:00Z' },
    removed00001: { lastPolledAt: '2026-10-05T11:59:00Z' },
  };
  assert.deepEqual(selectDueMetricVideos(videos, poll, now).map((entry) => entry.video.videoId), ['newest00001', 'weekold0001']);
  assert.equal(metricCadenceMinutes(videos[0][1][2], poll.oldstatic01, now, false), 1440);
  assert.deepEqual(Object.keys(pruneMetricPollToVisibleVideos(poll, new Map(videos))).sort(), [
    'newest00001', 'oldstatic01', 'weekold0001',
  ]);
});

test('deletion promotes known fourth video to immediate metric polling without a notification', () => {
  const now = Date.parse('2026-10-05T12:00:00Z');
  const channelId = 'UC0000000000000000000000';
  const videos = [
    { videoId: 'newest00001', publishedAt: '2026-10-05T11:00:00Z' },
    { videoId: 'second00001', publishedAt: '2026-10-05T10:00:00Z' },
    { videoId: 'third000001', publishedAt: '2026-10-05T09:00:00Z' },
    { videoId: 'fourth00001', publishedAt: '2026-10-05T08:00:00Z' },
  ];
  const initialRecents = new Map([[channelId, videos]]);
  const initialPoll = Object.fromEntries(videos.map((video) => [video.videoId, {
    lastPolledAt: '2026-10-05T11:59:00Z',
  }]));
  const pruned = pruneMetricPollToVisibleVideos(initialPoll, initialRecents);
  assert.equal(Object.hasOwn(pruned, 'fourth00001'), false);

  const promoted = videos.slice(1);
  const due = selectDueMetricVideos(new Map([[channelId, promoted]]), pruned, now);
  assert.ok(due.some((entry) => entry.video.videoId === 'fourth00001'));
  const classified = classifyRssVideosForNotification({
    ids: videos.map((video) => video.videoId),
    highWatermarkAt: '2026-10-05T11:00:00Z',
    highWatermarkIds: ['newest00001'],
  }, promoted);
  assert.equal(classified.find((video) => video.videoId === 'fourth00001').reason, 'known-id');
  assert.equal(classified.some((video) => video.isNew), false);
});

test('quota state persists within a Pacific day and resets at DST-aware midnight', () => {
  const before = Date.parse('2026-03-09T06:59:59Z');
  const after = Date.parse('2026-03-09T07:00:00Z');
  const first = normalizeYoutubeDataApiState(null, before);
  first.quota.general.units = 42;
  assert.equal(normalizeYoutubeDataApiState(first, before).quota.general.units, 42);
  assert.equal(normalizeYoutubeDataApiState(first, after).quota.general.units, 0);
  assert.notEqual(pacificQuotaWindow(before).day, pacificQuotaWindow(after).day);
});

test('local comment observations preserve null and explicit zero across normalization and restart', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tubepulse-comment-observation-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const now = Date.parse('2026-10-05T12:00:00Z');
  const first = updateMetricPollObservation({}, {
    views: '100', likes: '10', dislikes: null, comments: null,
  }, now);
  assert.deepEqual(first.commentObservation, {
    count: null,
    observedAt: '2026-10-05T12:00:00.000Z',
  });
  const second = updateMetricPollObservation(first, {
    views: '100', likes: '10', dislikes: null, comments: '0',
  }, now + 300_000);
  assert.deepEqual(second.commentObservation, {
    count: '0',
    observedAt: '2026-10-05T12:05:00.000Z',
  });
  assert.equal(second.staticStreak, 1, 'comment movement cannot change adaptive metric cadence');
  const migrated = updateMetricPollObservation({
    lastObserved: '{"comments":"9","dislikes":null,"likes":"10","views":"100"}',
    staticStreak: 4,
  }, {
    views: '100', likes: '10', dislikes: null, comments: '11',
  }, now + 600_000);
  assert.equal(migrated.staticStreak, 5, 'legacy comment signatures migrate without resetting cadence');

  const normalized = normalizeYoutubeDataApiState({ metricPoll: { videoid00001: second } }, now);
  const stateFile = createHomeSchedulerStateFile(dataDir, 'shadow');
  const state = await stateFile.read();
  state.youtubeDataApi = normalized;
  await stateFile.write(state);
  const restored = normalizeYoutubeDataApiState((await stateFile.read()).youtubeDataApi, now);
  assert.deepEqual(restored.metricPoll.videoid00001.commentObservation, second.commentObservation);
});

class MemoryKv {
  constructor(values = {}) {
    this.values = new Map(Object.entries(values).map(([key, value]) => [key, JSON.stringify(value)]));
    this.puts = [];
  }
  async get(key, type) {
    const value = this.values.get(key) ?? null;
    return type === 'json' && value !== null ? JSON.parse(value) : value;
  }
  async put(key, value) { this.puts.push(key); this.values.set(key, String(value)); }
  async delete(key) { this.values.delete(key); }
}

test('comment-only statistics advance no canonical KV write or publication delta', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tubepulse-comment-only-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const now = Date.parse('2026-10-05T12:00:00Z');
  const currentHour = Math.floor(now / 3_600_000);
  const channelId = 'UC0000000000000000000000';
  const video = {
    videoId: 'videoid00001', title: 'Stable', publishedAt: '2026-10-05T11:00:00Z',
    thumbnail: null, type: 'video', link: 'https://www.youtube.com/watch?v=videoid00001',
    views: '100', likes: '10', dislikes: null, comments: '3',
    viewsLastCheckedHour: currentHour, likesLastCheckedHour: currentHour,
    commentsLastCheckedHour: currentHour - 48,
  };
  const recentKey = `channel:${channelId}:recent`;
  const kv = new MemoryKv({ [recentKey]: [video] });
  const stateFile = createHomeSchedulerStateFile(dataDir, 'shadow');
  const runner = new HomeSchedulerRunner({
    config: {
      mode: 'shadow', dataDir, repoRoot: path.resolve('.'), workerBindings: {}, quiet: true,
      sync: { configured: false }, leaseTtlMs: 10_000,
    },
    stateFile,
    now: () => now,
  });
  const recents = new Map([[channelId, [video]]]);
  await runner.applyStatistics(kv, recents, [{ channelId, video }], new Map([[
    video.videoId,
    { views: '100', likes: '10', dislikes: null, comments: '99' },
  ]]));
  assert.deepEqual(kv.puts, []);
  assert.deepEqual(await kv.get(recentKey, 'json'), [video]);
  assert.deepEqual(recents.get(channelId), [video]);
});

test('unchanged 85-channel detector uses two calls and no playlist request; count changes reconcile', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tubepulse-data-api-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const now = Date.parse('2026-10-05T12:00:00Z');
  const channels = Array.from({ length: 85 }, (_, index) => `UC${String(index).padStart(22, '0')}`);
  const stateFile = createHomeSchedulerStateFile(dataDir, 'shadow');
  const state = await stateFile.read();
  state.youtubeDataApi = normalizeYoutubeDataApiState(null, now);
  for (const channelId of channels) state.youtubeDataApi.channels[channelId] = {
    uploadsPlaylistId: `UU${channelId.slice(2)}`, videoCount: 10,
    lastReconciledAt: new Date(now).toISOString(),
  };
  await stateFile.write(state);
  const kv = new MemoryKv({ 'channels:active': channels });
  let channelCalls = 0;
  let playlistCalls = 0;
  const api = {
    async listChannels(ids) {
      channelCalls++;
      return { items: ids.map((id) => ({ id, statistics: { videoCount: id === channels[0] && channelCalls > 2 ? '11' : '10' }, contentDetails: { relatedPlaylists: { uploads: `UU${id.slice(2)}` } } })) };
    },
    async listPlaylistItems() { playlistCalls++; return { items: [] }; },
    async listVideoDetails() { return { items: [] }; },
    async batchGetStats() { return { items: [] }; },
  };
  const runner = new HomeSchedulerRunner({
    config: {
      mode: 'shadow', videoSourceMode: 'youtube-api', dataDir, workerBindings: { YOUTUBE_API_KEY: 'test' },
      sync: { configured: false, concurrency: 1 },
      youtubeSafetyReconcileHours: 6, youtubeMaxReconciliationsPerCycle: 5, youtubeMaxPlaylistPages: 3,
      youtubeDailyQuotaUnits: 10_000, youtubeQuotaReserveUnits: 1_000,
      youtubeStatisticsDailyQuotaUnits: 10_000, youtubeStatisticsReserveUnits: 1_000,
      channelTimeoutMs: 1000,
    },
    stateFile, youtubeDataApiClient: api, now: () => now,
  });
  const first = await runner.runYoutubeDataApiCycle({}, kv, now);
  assert.equal(first.detectorRequests, 2);
  assert.equal(channelCalls, 2);
  assert.equal(playlistCalls, 0);
  const second = await runner.runYoutubeDataApiCycle({}, kv, now + 300_000);
  assert.equal(second.changedCount, 1);
  assert.equal(playlistCalls, 1);
});

test('a valid empty channel is reconciled without its missing uploads playlist and discovers its first upload', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tubepulse-data-api-empty-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const now = Date.parse('2026-10-08T05:00:00Z');
  const channelId = 'UC0000000000000000000000';
  const stateFile = createHomeSchedulerStateFile(dataDir, 'shadow');
  const kv = new MemoryKv({ 'channels:active': [channelId] });
  let videoCount = 0;
  let playlistCalls = 0;
  const api = {
    async listChannels() {
      return { items: [{
        id: channelId,
        statistics: { videoCount: String(videoCount) },
        contentDetails: { relatedPlaylists: { uploads: 'UU0000000000000000000000' } },
      }] };
    },
    async listPlaylistItems() {
      playlistCalls++;
      return { items: [{
        snippet: { title: 'First upload', publishedAt: '2026-10-08T05:04:00Z' },
        contentDetails: { videoId: 'firstvideo01', videoPublishedAt: '2026-10-08T05:04:00Z' },
        status: { privacyStatus: 'public' },
      }] };
    },
    async listVideoDetails(ids) {
      return { items: ids.map((id) => ({
        id,
        snippet: { title: 'First upload', publishedAt: '2026-10-08T05:04:00Z', channelTitle: 'Channel', thumbnails: {} },
        status: { privacyStatus: 'public' },
      })) };
    },
    async batchGetStats() { return { items: [] }; },
  };
  const runner = new HomeSchedulerRunner({
    config: {
      mode: 'shadow', videoSourceMode: 'youtube-api', dataDir, sync: { configured: false, concurrency: 1 },
      workerBindings: { YOUTUBE_API_KEY: 'test', TUBEPULSE_NOTIFICATION_MODE: 'shadow' },
      youtubeSafetyReconcileHours: 6, youtubeMaxReconciliationsPerCycle: 5,
      youtubeMaxMigrationReconciliationsPerCycle: 100, youtubeMaxPlaylistPages: 3,
      youtubeDailyQuotaUnits: 10_000, youtubeQuotaReserveUnits: 1_000,
      youtubeStatisticsDailyQuotaUnits: 10_000, youtubeStatisticsReserveUnits: 1_000,
      channelTimeoutMs: 1000,
    },
    stateFile, youtubeDataApiClient: api, now: () => now,
  });

  const empty = await runner.runYoutubeDataApiCycle({ TUBEPULSE_KV: kv }, kv, now);
  assert.equal(empty.outcome, 'ok');
  assert.equal(empty.reconciliationDueCount, 0);
  assert.equal(playlistCalls, 0);
  let state = await stateFile.read();
  assert.equal(state.youtubeDataApi.channels[channelId].videoCount, 0);
  assert.equal(state.youtubeDataApi.channels[channelId].lastReconcileOutcome, 'empty');
  assert.equal(state.youtubeDataApi.channels[channelId].lastPageCount, 0);
  assert.ok(state.youtubeDataApi.channels[channelId].lastReconciledAt);
  assert.equal(state.youtubeDataApi.quota.general.failures, 0);

  videoCount = 1;
  const firstUpload = await runner.runYoutubeDataApiCycle({ TUBEPULSE_KV: kv }, kv, now + 300_000);
  assert.equal(firstUpload.changedCount, 1);
  assert.equal(firstUpload.reconciledCount, 1);
  assert.equal(playlistCalls, 1);
  assert.equal((await kv.get(`channel:${channelId}:recent`, 'json'))[0].videoId, 'firstvideo01');
  state = await stateFile.read();
  assert.notEqual(state.youtubeDataApi.channels[channelId].lastReconcileOutcome, 'empty');
});

test('an unresolved YouTube reconciliation error remains current until a successful cycle clears it', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tubepulse-data-api-error-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const now = Date.parse('2026-10-08T05:00:00Z');
  const channelId = 'UC0000000000000000000000';
  const stateFile = createHomeSchedulerStateFile(dataDir, 'shadow');
  const kv = new MemoryKv({ 'channels:active': [channelId] });
  let fail = true;
  const api = {
    async listChannels() {
      return { items: [{
        id: channelId,
        statistics: { videoCount: '1' },
        contentDetails: { relatedPlaylists: { uploads: 'UU0000000000000000000000' } },
      }] };
    },
    async listPlaylistItems() {
      if (fail) throw Object.assign(new Error('playlist unavailable'), { category: 'not-found' });
      return { items: [] };
    },
    async listVideoDetails() { return { items: [] }; },
    async batchGetStats() { return { items: [] }; },
  };
  const runner = new HomeSchedulerRunner({
    config: {
      mode: 'shadow', videoSourceMode: 'youtube-api', dataDir, sync: { configured: false, concurrency: 1 },
      workerBindings: { YOUTUBE_API_KEY: 'test' },
      youtubeSafetyReconcileHours: 6, youtubeMaxReconciliationsPerCycle: 5,
      youtubeMaxMigrationReconciliationsPerCycle: 100, youtubeMaxPlaylistPages: 3,
      youtubeDailyQuotaUnits: 10_000, youtubeQuotaReserveUnits: 1_000,
      youtubeStatisticsDailyQuotaUnits: 10_000, youtubeStatisticsReserveUnits: 1_000,
      channelTimeoutMs: 1000,
    },
    stateFile, youtubeDataApiClient: api, now: () => now,
  });

  const failed = await runner.runYoutubeDataApiCycle({}, kv, now);
  assert.equal(failed.outcome, 'partial');
  let state = await stateFile.read();
  assert.equal(state.youtubeDataApi.lastError.category, 'not-found');
  assert.equal(state.youtubeDataApi.quota.general.failures, 1);

  fail = false;
  const recovered = await runner.runYoutubeDataApiCycle({}, kv, now + 300_000);
  assert.equal(recovered.outcome, 'ok');
  state = await stateFile.read();
  assert.equal(state.youtubeDataApi.lastError, null);
  assert.equal(state.youtubeDataApi.quota.general.failures, 1, 'historical failure count remains available');
});

test('an unchanged detector baseline cannot suppress an established channel migration catch-up', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tubepulse-data-api-migration-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const now = Date.parse('2026-10-05T12:00:00Z');
  const channelId = 'UC0000000000000000000000';
  const stateFile = createHomeSchedulerStateFile(dataDir, 'shadow');
  const state = await stateFile.read();
  state.youtubeDataApi = normalizeYoutubeDataApiState(null, now);
  state.youtubeDataApi.channels[channelId] = { uploadsPlaylistId: 'UU0000000000000000000000', videoCount: 10 };
  await stateFile.write(state);
  const kv = new MemoryKv({
    'channels:active': [channelId],
    [`channel:${channelId}:known:videos`]: {
      ids: ['knownvideo01'], highWatermarkAt: '2026-10-05T09:00:00Z', highWatermarkIds: ['knownvideo01'],
      seededAt: '2026-10-05T09:00:00Z', updatedAt: '2026-10-05T09:00:00Z',
    },
    [`channel:${channelId}:recent`]: [{ videoId: 'knownvideo01', title: 'Known', publishedAt: '2026-10-05T09:00:00Z' }],
  });
  let playlistCalls = 0;
  const api = {
    async listChannels() { return { items: [{ id: channelId, statistics: { videoCount: '10' }, contentDetails: { relatedPlaylists: { uploads: 'UU0000000000000000000000' } } }] }; },
    async listPlaylistItems() {
      playlistCalls++;
      return { items: [
        { snippet: { title: 'Missed', publishedAt: '2026-10-05T11:00:00Z' }, contentDetails: { videoId: 'missedvideo1', videoPublishedAt: '2026-10-05T11:00:00Z' }, status: { privacyStatus: 'public' } },
        { snippet: { title: 'Known', publishedAt: '2026-10-05T09:00:00Z' }, contentDetails: { videoId: 'knownvideo01', videoPublishedAt: '2026-10-05T09:00:00Z' }, status: { privacyStatus: 'public' } },
      ] };
    },
    async listVideoDetails() { return { items: [{ id: 'missedvideo1', snippet: { title: 'Missed', publishedAt: '2026-10-05T11:00:00Z', channelTitle: 'Channel', thumbnails: {} }, status: { privacyStatus: 'public' } }] }; },
    async batchGetStats() { return { items: [] }; },
  };
  const runner = new HomeSchedulerRunner({
    config: {
      mode: 'shadow', videoSourceMode: 'youtube-api', dataDir, sync: { configured: false, concurrency: 1 },
      workerBindings: { YOUTUBE_API_KEY: 'test', TUBEPULSE_NOTIFICATION_MODE: 'shadow' },
      youtubeSafetyReconcileHours: 6, youtubeMaxReconciliationsPerCycle: 5,
      youtubeMaxMigrationReconciliationsPerCycle: 100, youtubeMaxPlaylistPages: 3,
      youtubeDailyQuotaUnits: 10_000, youtubeQuotaReserveUnits: 1_000,
      youtubeStatisticsDailyQuotaUnits: 10_000, youtubeStatisticsReserveUnits: 1_000,
      channelTimeoutMs: 1000,
    },
    stateFile, youtubeDataApiClient: api, now: () => now,
  });
  const result = await runner.runYoutubeDataApiCycle({ TUBEPULSE_KV: kv }, kv, now);
  assert.equal(result.changedCount, 0);
  assert.equal(result.reconciledCount, 1, JSON.stringify(result));
  assert.equal(playlistCalls, 1);
  assert.equal((await kv.get(`channel:${channelId}:recent`, 'json'))[0].videoId, 'missedvideo1');
});
