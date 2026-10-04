#!/usr/bin/env node
import { loadDotEnv, readConfig } from './config.mjs';
import { createTubePulseService } from './service.mjs';

loadDotEnv();

function usage() {
  return `TubePulse self-host preview

Usage:
  npm start
  node src/cli.mjs serve
  node src/cli.mjs status
  node src/cli.mjs admin takeover
  node src/cli.mjs admin standby
  node src/cli.mjs sync pull
  node src/cli.mjs sync push [--apply]
`;
}

async function callAdmin(config, pathname, body) {
  if (!config.adminToken) throw new Error('TUBEPULSE_ADMIN_TOKEN is required for CLI admin operations');
  const baseUrl = process.env.TUBEPULSE_SELF_HOST_URL || `http://127.0.0.1:${config.port}`;
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.adminToken}`,
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const payload = await response.json().catch(() => ({ error: response.statusText }));
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  console.log(JSON.stringify(payload, null, 2));
}

async function main() {
  const [command = 'serve', subcommand, flag] = process.argv.slice(2);
  const config = readConfig();
  if (command === 'serve') {
    const service = await createTubePulseService(config);
    console.log(`TubePulse self-host preview listening at ${service.url} (${config.mode})`);
    for (const warning of config.warnings) console.warn(`Warning: ${warning}`);
    const shutdown = async () => {
      await service.close();
      process.exit(0);
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    return;
  }
  if (command === 'status') {
    const baseUrl = process.env.TUBEPULSE_SELF_HOST_URL || `http://127.0.0.1:${config.port}`;
    const response = await fetch(`${baseUrl}/_tubepulse/status`);
    console.log(JSON.stringify(await response.json(), null, 2));
    return;
  }
  if (command === 'admin' && ['takeover', 'standby'].includes(subcommand)) {
    await callAdmin(config, `/_tubepulse/admin/${subcommand}`);
    return;
  }
  if (command === 'sync' && subcommand === 'pull') {
    await callAdmin(config, '/_tubepulse/admin/sync/pull');
    return;
  }
  if (command === 'sync' && subcommand === 'push') {
    if (flag && flag !== '--apply') throw new Error(`Unknown flag: ${flag}`);
    await callAdmin(config, '/_tubepulse/admin/sync/push', { apply: flag === '--apply' });
    return;
  }
  console.error(usage());
  process.exitCode = 2;
}

main().catch((error) => {
  console.error(`TubePulse self-host error: ${error.message}`);
  process.exitCode = 1;
});
