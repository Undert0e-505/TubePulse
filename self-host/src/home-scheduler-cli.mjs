#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadDotEnv } from './config.mjs';
import { publicHomeSchedulerConfig, readHomeSchedulerConfig } from './home-scheduler-config.mjs';
import { createHomeSchedulerRunner, createHomeSchedulerStateFile } from './home-scheduler.mjs';

const explicitEnvFile = process.env.TUBEPULSE_HOME_SCHEDULER_ENV_FILE;
loadDotEnv(explicitEnvFile ? path.resolve(explicitEnvFile) : path.resolve('.env.scheduler'));

function usage() {
  return `TubePulse Home scheduler

Usage:
  node src/home-scheduler-cli.mjs run
  node src/home-scheduler-cli.mjs once [--sweeps=1..12]
  node src/home-scheduler-cli.mjs status
  node src/home-scheduler-cli.mjs health

The default mode is shadow. Active mode is rejected unless remote writes,
notifications, the trigger-disable confirmation, and the activation latch are
all explicitly configured.
`;
}

async function readStatus(config) {
  return await createHomeSchedulerStateFile(config.dataDir, config.mode).read();
}

async function main() {
  const [command = 'run', option] = process.argv.slice(2);
  const config = readHomeSchedulerConfig();
  if (command === 'status') {
    console.log(JSON.stringify({ config: publicHomeSchedulerConfig(config), state: await readStatus(config) }, null, 2));
    return;
  }
  if (command === 'health') {
    const state = await readStatus(config);
    if (!state.startedAt || state.lease?.state !== 'held') throw new Error('Home scheduler is not holding its lease');
    const lock = JSON.parse(await fs.readFile(path.join(config.dataDir, 'home-scheduler.lock'), 'utf8'));
    if (Date.parse(lock.expiresAt || '') <= Date.now()) throw new Error('Home scheduler lease heartbeat is stale');
    console.log(JSON.stringify({ ok: true, mode: state.mode, lastSweepAt: state.lastSweep?.finishedAt || null }));
    return;
  }
  if (!['run', 'once'].includes(command)) {
    console.error(usage());
    process.exitCode = 2;
    return;
  }

  const runner = await createHomeSchedulerRunner(config);
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await runner.close();
  };
  process.once('SIGINT', () => close().finally(() => process.exit(0)));
  process.once('SIGTERM', () => close().finally(() => process.exit(0)));

  if (command === 'once') {
    try {
      if (config.mode === 'active') {
        throw new Error('once is disabled in active mode because a fleet-wide manual sweep would defeat RSS anti-burst protection');
      }
      const match = option === undefined ? null : /^--sweeps=(\d+)$/.exec(option);
      if (option !== undefined && !match) throw new Error('once accepts only --sweeps=<positive integer>');
      const sweepCount = match ? Number(match[1]) : 1;
      if (!Number.isInteger(sweepCount) || sweepCount < 1 || sweepCount > 12) {
        throw new Error('once sweep count must be between 1 and 12');
      }
      if (sweepCount > 1 && config.mode !== 'shadow') {
        throw new Error('multi-sweep measurement is allowed only in shadow mode');
      }
      const firstBoundary = Math.floor(Date.now() / 300_000) * 300_000 + 300_000;
      const results = [];
      for (let index = 0; index < sweepCount; index++) {
        results.push(await runner.runTick(firstBoundary + index * 300_000, {
          forceSweep: true,
          // Multi-sweep one-shot is an explicit shadow measurement: repeat the
          // post pass too so its steady-state mutation rate is observable
          // without waiting an hour. Normal `run` cadence remains hourly.
          forcePosts: true,
        }));
      }
      console.log(JSON.stringify(sweepCount === 1 ? results[0] : { sweepCount, results }, null, 2));
    } finally {
      await close();
    }
    return;
  }

  await runner.run();
  console.log(JSON.stringify({
    message: 'TubePulse Home scheduler started',
    config: publicHomeSchedulerConfig(config),
  }));
}

main().catch((error) => {
  console.error(`TubePulse Home scheduler error: ${error.message}`);
  process.exitCode = 1;
});
