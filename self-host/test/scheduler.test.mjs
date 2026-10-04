import assert from 'node:assert/strict';
import test from 'node:test';
import { SchedulerController } from '../src/scheduler.mjs';

class MemoryStateFile {
  constructor(value = { mirrorRole: 'standby' }) { this.value = structuredClone(value); }
  async read() { return structuredClone(this.value); }
  async write(value) { this.value = structuredClone(value); }
}

class FakeRuntime {
  constructor() { this.calls = []; }
  async dispatchScheduled(name, scheduledTime, cron) { this.calls.push({ name, scheduledTime, cron }); }
}

test('standalone is active and aligns RSS to five-minute ticks', async () => {
  const runtime = new FakeRuntime();
  const scheduler = new SchedulerController({
    runtime,
    mode: 'standalone',
    stateFile: new MemoryStateFile(),
    timers: false,
  });
  await scheduler.start();
  const fiveMinuteBoundary = Date.UTC(2026, 8, 20, 12, 5, 0);
  await scheduler.tick(fiveMinuteBoundary);
  assert.deepEqual(runtime.calls.map((call) => call.name), ['posts', 'aux', 'rss-0', 'rss-1', 'rss-2']);
  runtime.calls.length = 0;
  await scheduler.tick(fiveMinuteBoundary + 60_000);
  assert.deepEqual(runtime.calls.map((call) => call.name), ['posts', 'aux']);
});

test('mirror stays idle until sticky takeover and returns only by explicit standby', async () => {
  const runtime = new FakeRuntime();
  const stateFile = new MemoryStateFile();
  const scheduler = new SchedulerController({ runtime, mode: 'mirror', stateFile, timers: false });
  await scheduler.start();
  await scheduler.tick(Date.UTC(2026, 8, 20, 12, 5, 0));
  assert.equal(runtime.calls.length, 0);
  assert.equal(scheduler.status().state, 'standby');

  await scheduler.takeover('test');
  await scheduler.tick(Date.UTC(2026, 8, 20, 12, 5, 0));
  assert.equal(runtime.calls.length, 5);
  assert.equal(stateFile.value.mirrorRole, 'active');
  assert.equal(scheduler.status().stickyTakeover, true);

  const restarted = new SchedulerController({ runtime: new FakeRuntime(), mode: 'mirror', stateFile, timers: false });
  await restarted.start();
  assert.equal(restarted.status().state, 'active');
  await restarted.standby('test-complete');
  assert.equal(restarted.status().state, 'standby');
  assert.equal(stateFile.value.mirrorRole, 'standby');
});

test('overlapping runs of one worker are skipped and reported', async () => {
  let release;
  const runtime = {
    dispatchScheduled: () => new Promise((resolve) => { release = resolve; }),
  };
  const scheduler = new SchedulerController({
    runtime,
    mode: 'standalone',
    stateFile: new MemoryStateFile(),
    timers: false,
  });
  await scheduler.start();
  const first = scheduler.runWorker('posts', Date.now());
  const second = await scheduler.runWorker('posts', Date.now());
  assert.equal(second.outcome, 'overlap-skipped');
  assert.equal(scheduler.status().workers.posts.skippedOverlaps, 1);
  release();
  await first;
});
