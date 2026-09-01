import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  selectCommunityPostWork,
  selectRssShardWork,
} from './tubepulse-cron/shared.mjs';

const sixChannels = ['channel-f', 'channel-b', 'channel-e', 'channel-a', 'channel-d', 'channel-c'];

const rssCoverage = new Set();
for (let minuteSlot = 0; minuteSlot < 3; minuteSlot++) {
  for (let shardIndex = 0; shardIndex < 2; shardIndex++) {
    const work = selectRssShardWork(sixChannels, shardIndex, 3, minuteSlot);
    assert.ok(work);
    assert.equal(work.activeShardCount, 2);
    rssCoverage.add(work.channelId);
  }
}
assert.deepEqual([...rssCoverage].sort(), [...sixChannels].sort());
assert.equal(selectRssShardWork(sixChannels, 2, 3, 0), null);

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
  'tubepulse-posts',
  'tubepulse-aux',
]) {
  const config = await readFile(new URL(`./${worker}/wrangler.toml`, import.meta.url), 'utf8');
  assert.match(config, /crons\s*=\s*\["\* \* \* \* \*"\]/, `${worker} must run every minute`);
}

const retiredConfig = await readFile(new URL('./tubepulse-cron/wrangler.toml', import.meta.url), 'utf8');
assert.match(retiredConfig, /crons\s*=\s*\[\]/, 'retired tubepulse-cron must remain unscheduled');

console.log('scheduled worker rotation: PASS (six-channel RSS and posts coverage)');
