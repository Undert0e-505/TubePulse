import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { prometheusText } from '../src/prometheus.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

test('wallboard and diagnostics dashboards are valid, provisioned, and use one datasource', () => {
  const wallboard = JSON.parse(read('monitoring', 'grafana', 'dashboards', 'tubepulse-operations.json'));
  const diagnostics = JSON.parse(read('monitoring', 'grafana', 'dashboards', 'tubepulse-diagnostics.json'));
  assert.equal(wallboard.uid, 'tubepulse-operations');
  assert.equal(wallboard.title, 'TubePulse Wallboard');
  assert.equal(diagnostics.uid, 'tubepulse-diagnostics');
  assert.equal(diagnostics.title, 'TubePulse Diagnostics');
  assert.ok(wallboard.panels.length >= 10);
  assert.ok(diagnostics.panels.length >= 10);
  assert.match(read('monitoring', 'grafana', 'provisioning', 'dashboards', 'default.yml'), /\/etc\/grafana\/dashboards/);
  assert.match(read('monitoring', 'grafana', 'provisioning', 'datasources', 'prometheus.yml'), /http:\/\/prometheus:9090/);
});

test('wallboard is a readable one-screen 24-column health overview', () => {
  const dashboard = JSON.parse(read('monitoring', 'grafana', 'dashboards', 'tubepulse-operations.json'));
  assert.equal(dashboard.refresh, '30s');
  assert.deepEqual(dashboard.time, { from: 'now-24h', to: 'now' });
  assert.equal(dashboard.timezone, 'utc');
  assert.ok(dashboard.tags.includes('wallboard'));

  const occupied = new Set();
  for (const panel of dashboard.panels) {
    const { x, y, w, h } = panel.gridPos;
    assert.ok(x >= 0 && y >= 0 && w > 0 && h > 0, `${panel.title} needs a valid grid position`);
    assert.ok(x + w <= 24, `${panel.title} exceeds the 24-column grid`);
    assert.ok(y + h <= 23, `${panel.title} falls below the one-screen wallboard bound`);
    for (let row = y; row < y + h; row += 1) {
      for (let column = x; column < x + w; column += 1) {
        const cell = `${column}:${row}`;
        assert.ok(!occupied.has(cell), `${panel.title} overlaps another panel at ${cell}`);
        occupied.add(cell);
      }
    }
  }

  const byTitle = new Map(dashboard.panels.map((panel) => [panel.title, panel]));
  for (const title of [
    'Overall health', 'Data freshness', 'Host authority', 'Active risks',
    'Active 24h', 'Active 7d', 'Registered', 'Push capable', 'Active channels',
    'Memberships', 'Max / install', 'D1 writes today', 'D1 projected EOD', 'YouTube quota',
    'Notifications', 'Worker requests / 5m', 'D1 rows / window',
    'Notification outcomes', 'Actionable signals',
  ]) assert.ok(byTitle.has(title), `wallboard is missing ${title}`);

  const overall = byTitle.get('Overall health');
  assert.match(overall.targets[0].expr, /tubepulse_collector_collection_success/);
  assert.match(overall.targets[0].expr, /tubepulse_host_authority_current/);
  assert.equal(overall.fieldConfig.defaults.noValue, 'NO DATA');
  assert.equal(overall.fieldConfig.defaults.mappings[0].options['0'].text, 'FAULT');
  assert.equal(overall.fieldConfig.defaults.mappings[0].options['1'].text, 'ATTENTION');
  assert.equal(overall.fieldConfig.defaults.mappings[0].options['2'].text, 'HEALTHY');
  assert.deepEqual(overall.fieldConfig.defaults.thresholds.steps.map(({ color, value }) => ({ color, value })), [
    { color: 'red', value: null },
    { color: 'orange', value: 1 },
    { color: 'green', value: 2 },
  ]);
  assert.equal(overall.targets[0].instant, true);
  assert.equal(overall.targets[0].range, false);

  const risks = byTitle.get('Active risks');
  assert.equal(risks.fieldConfig.defaults.mappings[0].options['0'].text, 'CRITICAL');
  assert.equal(risks.fieldConfig.defaults.mappings[0].options['1'].text, 'REVIEW BELOW');
  assert.equal(risks.fieldConfig.defaults.mappings[0].options['2'].text, 'CLEAR');

  const freshness = byTitle.get('Data freshness');
  assert.equal(freshness.fieldConfig.defaults.unit, 's');
  assert.deepEqual(freshness.fieldConfig.defaults.thresholds.steps.map(({ value }) => value), [null, 660, 960]);

  for (const title of ['Active 24h', 'Active 7d', 'Registered', 'Push capable', 'Active channels', 'Memberships', 'Max / install']) {
    const audience = byTitle.get(title);
    assert.equal(audience.targets.length, 1);
    assert.equal(audience.targets[0].instant, true);
    assert.equal(audience.options.textMode, 'value');
    assert.ok(audience.options.text.valueSize >= 30);
    assert.equal(audience.fieldConfig.defaults.thresholds, undefined, 'scale counts must not use danger thresholds');
    assert.equal(audience.fieldConfig.defaults.color.fixedColor, 'blue');
  }

  for (const title of ['D1 writes today', 'D1 projected EOD', 'YouTube quota']) {
    const panel = byTitle.get(title);
    assert.equal(panel.fieldConfig.defaults.unit, 'percent');
    assert.equal(panel.fieldConfig.defaults.min, 0);
    assert.equal(panel.fieldConfig.defaults.max, 100);
    assert.deepEqual(panel.fieldConfig.defaults.thresholds.steps.map(({ value }) => value), [null, 70, 90]);
  }

  assert.match(byTitle.get('Actionable signals').targets[0].expr, /tubepulse_authority_pending_backup_consecutive_samples >= bool 2/);
  assert.doesNotMatch(byTitle.get('Actionable signals').targets[0].expr, /tubepulse_youtube_api_failures/);
  assert.match(byTitle.get('Overall health').targets[0].expr, /tubepulse_authority_pending_backup_consecutive_samples < bool 2/);
  assert.match(byTitle.get('Overall health').targets[0].expr, /tubepulse_authority_transaction_active_consecutive_samples < bool 2/);
  assert.doesNotMatch(byTitle.get('Overall health').targets[0].expr, /tubepulse_youtube_api_failures/);
  assert.match(byTitle.get('Actionable signals').targets[0].expr, /tubepulse_subscription_integrity_consistent/);
  assert.match(byTitle.get('Actionable signals').targets[0].expr, /tubepulse_notifications_durable_backlog/);
  assert.match(byTitle.get('Actionable signals').targets[0].expr, /tubepulse_cloudflare_worker_errors/);
  assert.deepEqual(byTitle.get('Actionable signals').fieldConfig.defaults.thresholds.steps.map(({ color, value }) => ({ color, value })), [
    { color: 'green', value: null },
    { color: 'orange', value: 1 },
    { color: 'red', value: 1000 },
  ]);
  assert.ok(byTitle.get('Actionable signals').targets.some(({ legendFormat }) => legendFormat === 'core availability'));
  assert.ok(byTitle.get('Actionable signals').targets.some(({ legendFormat }) => legendFormat === 'D1 persistent queue'));
  assert.ok(byTitle.get('Actionable signals').targets.some(({ legendFormat }) => legendFormat === 'D1 persistent transaction'));
  assert.ok(byTitle.get('Actionable signals').targets.some(({ legendFormat }) => legendFormat === 'YouTube current error'));
  for (const target of byTitle.get('Actionable signals').targets) {
    assert.equal(target.instant, true);
    assert.equal(target.range, false);
  }

  const serialized = JSON.stringify(dashboard);
  for (const sensitive of ['deviceId', 'channelId', 'fcmToken', 'installationId']) {
    assert.doesNotMatch(serialized, new RegExp(sensitive, 'i'));
  }
});

test('channels and subscriptions stat remains readable at mobile widths', () => {
  const dashboard = JSON.parse(read('monitoring', 'grafana', 'dashboards', 'tubepulse-diagnostics.json'));
  const panel = dashboard.panels.find(({ title }) => title === 'Channels and subscriptions');
  assert.ok(panel);
  assert.equal(panel.type, 'stat');
  assert.equal(panel.targets.length, 7);
  assert.equal(panel.options.textMode, 'value_and_name');
  assert.equal(panel.options.wideLayout, true);
  assert.ok(panel.options.text.titleSize >= 15);
  assert.ok(panel.options.text.valueSize >= 20);
  assert.ok(panel.gridPos.h >= 8);

  const panelBottom = panel.gridPos.y + panel.gridPos.h;
  const downstreamTop = Math.min(...dashboard.panels
    .filter(({ gridPos }) => gridPos.y > panel.gridPos.y)
    .map(({ gridPos }) => gridPos.y));
  assert.ok(downstreamTop >= panelBottom, 'downstream panels must not overlap the taller stat panel');
});

test('every dashboard target is well formed and references an exported or recorded metric', () => {
  const dashboards = [
    JSON.parse(read('monitoring', 'grafana', 'dashboards', 'tubepulse-operations.json')),
    JSON.parse(read('monitoring', 'grafana', 'dashboards', 'tubepulse-diagnostics.json')),
  ];
  const rules = read('monitoring', 'prometheus', 'rules.yml');
  const sample = prometheusText({
    collector: {
      lastCollectionSuccess: true, errorsTotal: 0,
      lastAttemptAt: '2026-10-06T00:05:00Z', lastSuccessAt: '2026-10-06T00:05:00Z',
      limits: { d1RowsWritten: 1, d1RowsRead: 1, workerRequests: 1 },
    },
    snapshot: {
      intervalStart: '2026-10-06T00:00:00Z', collection: { hostSuccess: true, cloudflareSuccess: true },
      host: {
        host: {}, installs: { new: { h24: 0 }, active: { h24: 0 }, appVersions: [{ version: '4.0.0', count: 0 }] },
        subscriptions: { integrityIssues: {}, perInstall: {} }, youtube: { general: {}, statistics: {} },
        notifications: {}, authority: { estimatedRows: {}, limits: {} },
      },
      cloudflare: {
        window: { workers: [{ script: 'active', status: 'success' }], d1: {}, durableObjects: {} },
        day: { workers: [{ script: 'active', status: 'success' }], d1: {}, durableObjects: {} },
      },
    },
  });
  const known = new Set(sample.trim().split('\n').map((line) => line.split(/[ {]/, 1)[0]));
  for (const match of rules.matchAll(/^\s*- record:\s*(tubepulse[^\s]+)\s*$/gm)) known.add(match[1]);

  for (const dashboard of dashboards) {
    for (const panel of dashboard.panels) {
      assert.ok(panel.description, `${dashboard.title}: ${panel.title} needs a description`);
      const refs = new Set();
      for (const target of panel.targets || []) {
        assert.equal(typeof target.expr, 'string', `${panel.title} target needs an expression`);
        assert.ok(target.expr.trim(), `${panel.title} target expression cannot be blank`);
        assert.ok(target.refId && !refs.has(target.refId), `${panel.title} target refIds must be unique`);
        refs.add(target.refId);
        for (const metric of target.expr.match(/\btubepulse(?::|_)[A-Za-z0-9_:]+/g) || []) {
          assert.ok(known.has(metric), `${panel.title} references unknown metric ${metric}`);
        }
      }
    }
  }
});

test('compose keeps collector and Prometheus on loopback and defaults Grafana to loopback', () => {
  const compose = read('monitoring', 'compose.yaml');
  for (const port of ['9464', '9090']) assert.match(compose, new RegExp(`127\\.0\\.0\\.1:.*${port}`));
  assert.match(compose, /TUBEPULSE_MONITORING_GRAFANA_BIND_ADDRESS:-127\.0\.0\.1/);
  assert.match(read('monitoring', '.env.local.example'), /TUBEPULSE_MONITORING_GRAFANA_BIND_ADDRESS=127\.0\.0\.1/);
  assert.match(compose, /prom\/prometheus:v[^@]+@sha256:[a-f0-9]{64}/);
  assert.match(compose, /grafana\/grafana:v?[^@]+@sha256:[a-f0-9]{64}/);
  assert.match(compose, /retention\.size=5GB/);
});

test('Grafana LAN firewall helper is narrowly scoped and supports safe dry-run', { skip: process.platform !== 'win32' }, () => {
  const scriptPath = path.join(root, 'monitoring', 'windows', 'Manage-TubePulseGrafanaLanAccess.ps1');
  const source = fs.readFileSync(scriptPath, 'utf8');
  assert.match(source, /-Profile Private/);
  assert.match(source, /-RemoteAddress LocalSubnet/);
  assert.match(source, /-InterfaceAlias \$lan\.InterfaceAlias/);
  assert.match(source, /-Protocol TCP -LocalPort \$LocalPort/);
  assert.match(source, /Refusing to create a firewall rule or change the network category/);
  assert.doesNotMatch(source, /Set-NetConnectionProfile/);

  const result = spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
    '-Mode', 'Install', '-DryRun',
  ], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const plan = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
  assert.equal(plan.DryRun, true);
  assert.equal(plan.PlannedProfile, 'Private');
  assert.equal(plan.PlannedRemoteAddress, 'LocalSubnet');
  assert.equal(plan.MutatedHost, false);
  assert.match(plan.LanUrl, /^http:\/\/\d+\.\d+\.\d+\.\d+:3000\//);
});

test('production supervisor starts monitoring asynchronously and best-effort', () => {
  const source = read('self-host', 'windows', 'Start-HomeAuthority.ps1');
  assert.match(source, /function Start-MonitoringBestEffort/);
  assert.match(source, /Start-Process[^\n]+-WindowStyle Hidden/);
  assert.match(source, /production authority remains unaffected/);
  assert.match(source, /if \(\$evaluation\.Success\)[\s\S]{0,400}Start-MonitoringBestEffort/);
});

test('tracked launchers never contain a token value or secret argument', () => {
  const source = [
    read('monitoring', 'windows', 'Start-TubePulseMonitoring.ps1'),
    read('logs', 'Open-TubePulse-Operations.ps1'),
    read('logs', 'Open-TubePulse-Operations.cmd'),
  ].join('\n');
  assert.doesNotMatch(source, /Bearer\s+[A-Za-z0-9._-]+|api[_-]?token\s*=|authority[_-]?secret\s*=/i);
  assert.match(source, /cloudflare-read-token\.txt/);
});
