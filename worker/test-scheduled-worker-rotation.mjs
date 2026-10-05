import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  selectCommunityPostWork,
  selectRssShardWork,
} from './tubepulse-cron/shared.mjs';

const FIVE_MINUTES_MS = 5 * 60 * 1000;
const RSS_MAX_SHARDS = 3;
const firstScheduledTime = Date.parse('2026-09-20T00:00:00.000Z');

// Exercise the same five-minute tick passed by the scheduled handlers. Every
// supported active-channel count must rotate through the complete sorted set.
for (let channelCount = 1; channelCount <= 100; channelCount++) {
  const channels = Array.from(
    { length: channelCount },
    (_, index) => `channel-${String(channelCount - index).padStart(2, '0')}`,
  );
  const expectedActiveShardCount = Math.min(
    RSS_MAX_SHARDS,
    Math.max(1, Math.ceil(channelCount / 5)),
  );
  const rssCoverage = new Set();

  for (let offset = 0; offset < channelCount; offset++) {
    const scheduledTime = firstScheduledTime + offset * FIVE_MINUTES_MS;
    const fiveMinuteTick = Math.floor(scheduledTime / FIVE_MINUTES_MS);
    for (let shardIndex = 0; shardIndex < RSS_MAX_SHARDS; shardIndex++) {
      const work = selectRssShardWork(channels, shardIndex, RSS_MAX_SHARDS, fiveMinuteTick);
      if (shardIndex >= expectedActiveShardCount) {
        assert.equal(work, null);
        continue;
      }
      assert.ok(work);
      assert.equal(work.activeShardCount, expectedActiveShardCount);
      rssCoverage.add(work.channelId);
    }
  }

  assert.deepEqual(
    [...rssCoverage].sort(),
    [...channels].sort(),
    `RSS rotation starved a channel with ${channelCount} active channels`,
  );
}

const sixChannels = ['channel-f', 'channel-b', 'channel-e', 'channel-a', 'channel-d', 'channel-c'];

const postCoverage = new Set();
for (let minuteSlot = 0; minuteSlot < 60; minuteSlot++) {
  const work = selectCommunityPostWork(sixChannels, minuteSlot);
  assert.ok(work);
  assert.equal(work.stepMinutes, 10);
  postCoverage.add(work.channelId);
}
assert.deepEqual([...postCoverage].sort(), [...sixChannels].sort());

for (const worker of [
  'tubepulse-rss-0',
  'tubepulse-rss-1',
  'tubepulse-rss-2',
]) {
  const config = await readFile(new URL(`./${worker}/wrangler.toml`, import.meta.url), 'utf8');
  assert.match(config, /crons\s*=\s*\[\]/, `${worker} must remain unscheduled while Home owns polling`);
  assert.match(config, /TUBEPULSE_ENABLE_FROZEN_KV_ROLLBACK\s*=\s*"false"/,
    `${worker} must fail closed against the frozen KV snapshot`);

  const source = await readFile(new URL(`./${worker}/index.js`, import.meta.url), 'utf8');
  assert.match(source, /scheduledTime \?\? Date\.now\(\)\) \/ 300000/, `${worker} must use a five-minute epoch tick`);
  assert.match(source, /TUBEPULSE_ENABLE_FROZEN_KV_ROLLBACK/,
    `${worker} must require explicit stale-KV rollback selection`);
}

for (const worker of ['tubepulse-posts', 'tubepulse-aux']) {
  const config = await readFile(new URL(`./${worker}/wrangler.toml`, import.meta.url), 'utf8');
  assert.match(config, /crons\s*=\s*\[\]/, `${worker} must remain unscheduled while Home owns polling`);
  assert.match(config, /TUBEPULSE_ENABLE_FROZEN_KV_ROLLBACK\s*=\s*"false"/,
    `${worker} must fail closed against the frozen KV snapshot`);
  const source = await readFile(new URL(`./${worker}/index.js`, import.meta.url), 'utf8');
  assert.match(source, /TUBEPULSE_ENABLE_FROZEN_KV_ROLLBACK/,
    `${worker} must require explicit stale-KV rollback selection`);
}

const retiredConfig = await readFile(new URL('./tubepulse-cron/wrangler.toml', import.meta.url), 'utf8');
assert.match(retiredConfig, /crons\s*=\s*\[\]/, 'retired tubepulse-cron must remain unscheduled');

console.log('scheduled worker rotation: PASS (RSS counts 1-100, posts, and Home-owned cron stand-down)');
