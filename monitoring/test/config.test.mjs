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
  assert.ok(wallboard.panels.length >= 7);
  assert.ok(diagnostics.panels.length >= 10);
  const installAggregates = diagnostics.panels.find(({ title }) => title === 'Install aggregates');
  assert.equal(
    installAggregates.targets.find(({ expr }) => expr === 'tubepulse_installs_active{window="h24"}').legendFormat,
    'backend seen 24h',
  );
  assert.match(installAggregates.description, /passive notification delivery alone does not/);
  assert.match(read('monitoring', 'grafana', 'provisioning', 'dashboards', 'default.yml'), /\/etc\/grafana\/dashboards/);
  assert.match(read('monitoring', 'grafana', 'provisioning', 'datasources', 'prometheus.yml'), /http:\/\/prometheus:9090/);
});

test('wallboard is a readable one-screen calm health overview', () => {
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
    'TubePulse status', 'Data freshness', 'Host authority', 'Attention', 'Audience & scale', 'Capacity',
    'Service traffic · 24h', 'Database activity · 24h', 'Notifications Sent', 'Invalid tokens · 24h',
  ]) assert.ok(byTitle.has(title), `wallboard is missing ${title}`);

  const status = byTitle.get('TubePulse status');
  assert.equal(status.options.colorMode, 'value', 'healthy status must not fill the panel background');
  assert.equal(status.targets.length, 1);
  assert.match(status.targets[0].expr, /tubepulse_collector_collection_success/);
  assert.match(status.targets[0].expr, /tubepulse_authority_pending_backup_consecutive_samples < bool 2/);
  assert.match(status.targets[0].expr, /tubepulse_authority_transaction_active_consecutive_samples < bool 2/);
  assert.match(status.targets[0].expr, /tubepulse_live_watch_degraded == bool 0/);
  assert.doesNotMatch(status.targets[0].expr, /tubepulse_youtube_api_failures/);
  assert.ok(status.options.text.valueSize >= 30);

  const freshness = byTitle.get('Data freshness');
  assert.equal(freshness.transparent, true);
  assert.match(freshness.targets[0].expr, /last_success_timestamp_seconds/);
  assert.equal(freshness.fieldConfig.defaults.unit, 's');

  const authority = byTitle.get('Host authority');
  assert.equal(authority.transparent, true);
  assert.match(authority.targets[0].expr, /tubepulse_host_authority_current/);
  assert.ok(authority.fieldConfig.defaults.mappings.some(({ options }) => options['1']?.text === 'Current'));

  const attention = byTitle.get('Attention');
  assert.equal(attention.options.colorMode, 'value');
  assert.match(attention.targets[0].expr, /tubepulse_subscription_integrity_consistent/);
  assert.match(attention.targets[0].expr, /tubepulse_notifications_durable_backlog/);
  assert.match(attention.targets[0].expr, /tubepulse_cloudflare_worker_errors/);
  assert.doesNotMatch(attention.targets[0].expr, /tubepulse_youtube_api_failures/);
  for (const required of ['Core availability', 'D1 queue', 'D1 transaction', 'YouTube error', 'Live precision degraded']) {
    assert.ok(attention.targets.some(({ legendFormat }) => legendFormat === required));
  }
  for (const target of attention.targets) {
    assert.equal(target.instant, true);
    assert.equal(target.range, false);
  }

  const audience = byTitle.get('Audience & scale');
  assert.equal(audience.type, 'text');
  assert.equal(audience.transparent, true);
  assert.deepEqual(audience.gridPos, { x: 0, y: 4, w: 24, h: 1 });

  const audienceTitles = [
    'Backend seen 24h', 'Backend seen 7d', 'Registered', 'Push capable',
    'Channels', 'Memberships', 'Max / install', 'Invalid tokens · 24h',
  ];
  const audiencePanels = audienceTitles.map((title) => {
    const panel = byTitle.get(title);
    assert.ok(panel, `audience overview is missing ${title}`);
    return panel;
  });
  assert.deepEqual(
    audiencePanels.map(({ gridPos: { x, y, w, h } }) => ({ x, y, w, h })),
    [
      { x: 0, y: 5, w: 6, h: 4 },
      { x: 6, y: 5, w: 6, h: 4 },
      { x: 12, y: 5, w: 6, h: 4 },
      { x: 18, y: 5, w: 6, h: 4 },
      { x: 0, y: 9, w: 6, h: 4 },
      { x: 6, y: 9, w: 6, h: 4 },
      { x: 12, y: 9, w: 6, h: 4 },
      { x: 18, y: 9, w: 6, h: 4 },
    ],
    'Audience & scale must remain an exact two-row by four-column compact metric grid',
  );
  const trendAudiencePanels = audiencePanels.filter(({ title }) => title !== 'Invalid tokens · 24h');
  for (const panel of trendAudiencePanels) {
    assert.equal(panel.type, 'volkovlabs-echarts-panel');
    assert.equal(panel.pluginVersion, '7.1.0');
    assert.equal(panel.transparent, true, `${panel.title} should read as part of one quiet group`);
    assert.equal(panel.targets.length, 1, `${panel.title} must remain readable when mobile panels stack`);
    assert.equal(panel.targets[0].instant, false);
    assert.equal(panel.targets[0].range, true);
    assert.equal(panel.options.editorMode, 'code');
    assert.equal(panel.options.renderer, 'canvas');
    assert.equal(panel.options.followTheme, true);
    assert.ok(panel.gridPos.h >= 4, `${panel.title} needs enough height for a value, history and axis`);
    assert.ok(panel.gridPos.w >= 3, `${panel.title} needs enough desktop width for an unambiguous label`);
    assert.equal(panel.fieldConfig.defaults.thresholds, undefined, 'scale counts must not use danger thresholds');
    assert.equal(panel.fieldConfig.defaults.color.fixedColor, '#4FC3F7');

    const chartFunction = panel.options.getOption;
    assert.doesNotThrow(() => new Function('context', chartFunction), `${panel.title} chart function must parse`);
    assert.match(chartFunction, /const latestPoint = points\.length \? points\[points\.length - 1\] : null/);
    assert.match(chartFunction, /rawValue == null \? Number\.NaN/);
    assert.match(chartFunction, /graphic:/, `${panel.title} must render the current value in the chart`);
    assert.match(chartFunction, /grid:/, `${panel.title} must keep value and history in one composition`);
    assert.match(chartFunction, /graphLeft/, `${panel.title} must reserve a same-row graph region`);
    assert.match(chartFunction, /xAxis:[\s\S]*type: 'time'/, `${panel.title} must expose a real time axis`);
    assert.match(chartFunction, /showMinLabel: true/);
    assert.match(chartFunction, /showMaxLabel: true/);
    assert.match(chartFunction, /splitNumber: width < 300 \? 2 : 3/, `${panel.title} must adapt axis density at narrow widths`);
    assert.match(chartFunction, /minInterval: width < 300 \? 12 \* 60 \* 60 \* 1000/, `${panel.title} must avoid cramped desktop time labels`);
    assert.match(chartFunction, /width < 300 && index % 2 === 1/, `${panel.title} must suppress alternate labels in narrow desktop cards`);
    assert.match(chartFunction, /const initialValue = finiteValues\.length \? finiteValues\[0\] : 0/);
    assert.match(chartFunction, /const minimumSpan = 10;/, `${panel.title} must prevent misleadingly tight count scaling`);
    assert.match(chartFunction, /const baselineMin = Math\.max\(0, initialValue - minimumSpan \/ 2\)/);
    assert.match(chartFunction, /const baselineMax = Math\.max\(initialValue \+ minimumSpan \/ 2, baselineMin \+ minimumSpan\)/);
    assert.doesNotMatch(chartFunction, /magnitude \* 0\.10/, `${panel.title} must use the fixed ten-unit minimum span`);
    assert.match(chartFunction, /min: yDomain\.min/);
    assert.match(chartFunction, /max: yDomain\.max/);
    assert.match(chartFunction, /#4FC3F7/);
    assert.match(chartFunction, /Awaiting samples/, `${panel.title} needs an explicit no-data state`);

    const render = new Function('context', chartFunction);
    const option = render({
      panel: {
        chart: { getWidth: () => 360 },
        data: {
          series: [{
            name: panel.title,
            fields: [
              { type: 'time', values: [1000, 2000, 3000] },
              { type: 'number', values: [7, null, 9] },
            ],
          }],
        },
      },
    });
    assert.equal(option.graphic[0].style.text, '9', `${panel.title} must display the last non-null value`);
    assert.deepEqual(option.series[0].data, [[1000, 7], [3000, 9]], `${panel.title} must not turn nulls into zeros`);
    assert.equal(option.xAxis.type, 'time');
    assert.equal(option.series[0].lineStyle.color, '#4FC3F7');
    assert.ok(String(option.grid.left).endsWith('%'), `${panel.title} graph must remain beside the value`);
    assert.ok(option.grid.right >= 18, `${panel.title} must reserve room for its final time label`);

    for (const domainCase of [
      { name: 'initial ten stays anchored', values: [10, 9, 11], expected: [5, 15] },
      { name: 'initial hundred stays anchored', values: [100, 101], expected: [95, 105] },
      { name: 'flat count', values: [70, 70], expected: [65, 75] },
      { name: 'zero count', values: [0, 0], expected: [0, 10] },
      { name: 'low initial count', values: [2, 2], expected: [0, 10] },
      { name: 'upper escape', values: [10, 20], fixedMin: 5, expandedMax: 20 },
      { name: 'lower escape', values: [10, 2], expandedMin: 2, fixedMax: 15 },
      { name: 'wide range', values: [0, 100], fixedMin: 0, expandedMax: 100 },
    ]) {
      const times = domainCase.values.map((_, index) => 1000 + index * 1000);
      const domainOption = render({
        panel: {
          chart: { getWidth: () => 360 },
          data: {
            series: [{
              name: panel.title,
              fields: [
                { type: 'time', values: times },
                { type: 'number', values: domainCase.values },
              ],
            }],
          },
        },
      });
      const domainSpan = domainOption.yAxis.max - domainOption.yAxis.min;
      const observedMin = Math.min(...domainCase.values);
      const observedMax = Math.max(...domainCase.values);
      assert.ok(domainOption.yAxis.min >= 0, `${panel.title}: ${domainCase.name} must keep a zero floor`);
      assert.ok(domainOption.yAxis.min <= observedMin, `${panel.title}: ${domainCase.name} must contain its minimum`);
      assert.ok(domainOption.yAxis.max >= observedMax, `${panel.title}: ${domainCase.name} must contain its maximum`);
      assert.ok(domainSpan >= 10 - 1e-9, `${panel.title}: ${domainCase.name} domain is too tight`);
      if (domainCase.expected) assert.deepEqual(
        [domainOption.yAxis.min, domainOption.yAxis.max],
        domainCase.expected,
        `${panel.title}: ${domainCase.name} must retain the initial ten-unit band`,
      );
      if (domainCase.fixedMin !== undefined) assert.equal(domainOption.yAxis.min, domainCase.fixedMin);
      if (domainCase.fixedMax !== undefined) assert.equal(domainOption.yAxis.max, domainCase.fixedMax);
      if (domainCase.expandedMin !== undefined) assert.ok(domainOption.yAxis.min < domainCase.expandedMin);
      if (domainCase.expandedMax !== undefined) assert.ok(domainOption.yAxis.max > domainCase.expandedMax);
    }
  }
  assert.deepEqual(
    audiencePanels.map(({ targets }) => targets[0].expr),
    [
      'tubepulse_installs_active{window="h24"}',
      'tubepulse_installs_active{window="d7"}',
      'tubepulse_installs_total',
      'tubepulse_installs_push_capable',
      'tubepulse_channels_active',
      'tubepulse_subscriptions_configured_memberships',
      'tubepulse_channels_per_install{statistic="max"}',
      'tubepulse_notifications_invalid_token_events{event="cleanup"}',
    ],
  );
  assert.match(byTitle.get('Backend seen 24h').description, /successful authenticated backend contact/);
  assert.match(byTitle.get('Backend seen 24h').description, /Passive notification delivery alone is not counted/);

  assert.equal(byTitle.has('Audience activity · 24h'), false, 'grouped audience history must not duplicate per-metric graphs');
  assert.equal(byTitle.has('Channel scale · 24h'), false, 'grouped channel history must not duplicate per-metric graphs');

  const capacity = byTitle.get('Capacity');
  assert.equal(capacity.type, 'bargauge');
  assert.equal(capacity.fieldConfig.defaults.unit, 'percent');
  assert.deepEqual(capacity.fieldConfig.defaults.thresholds.steps.map(({ value }) => value), [null, 70, 90]);
  assert.equal(capacity.targets.length, 5);
  const liveWatch = capacity.targets.find(({ legendFormat }) => legendFormat === 'Live watch');
  assert.ok(liveWatch);
  assert.equal(liveWatch.expr, '100 * tubepulse_live_watch_quota_ratio');
  assert.deepEqual(
    ['Capacity', 'Service traffic · 24h', 'Database activity · 24h', 'Notifications Sent']
      .map((title) => ({ title, ...byTitle.get(title).gridPos })),
    [
      { title: 'Capacity', x: 0, y: 13, w: 6, h: 8 },
      { title: 'Service traffic · 24h', x: 6, y: 13, w: 6, h: 8 },
      { title: 'Database activity · 24h', x: 12, y: 13, w: 6, h: 8 },
      { title: 'Notifications Sent', x: 18, y: 13, w: 6, h: 8 },
    ],
    'the operational row must remain four equal panels below Audience & scale',
  );

  for (const title of ['Service traffic · 24h', 'Database activity · 24h']) {
    const trend = byTitle.get(title);
    assert.equal(trend.type, 'timeseries');
    assert.ok(trend.gridPos.h >= 8);
    assert.equal(trend.fieldConfig.defaults.custom.axisGridShow, false);
    assert.equal(trend.options.legend.placement, 'bottom');
  }

  const notificationSends = byTitle.get('Notifications Sent');
  assert.equal(notificationSends.type, 'volkovlabs-echarts-panel');
  assert.equal(notificationSends.pluginVersion, '7.1.0');
  assert.deepEqual(
    notificationSends.targets.map(({ expr, legendFormat, instant, range }) => ({ expr, legendFormat, instant, range })),
    [
      {
        expr: 'tubepulse_notifications_fcm_accepted_interval',
        legendFormat: 'accepted by FCM',
        instant: false,
        range: true,
      },
      {
        expr: 'tubepulse_notifications_fcm_failed_interval',
        legendFormat: 'failed FCM send',
        instant: false,
        range: true,
      },
    ],
  );
  assert.match(notificationSends.description, /settled five-minute UTC collector samples/);
  assert.match(notificationSends.description, /Collection runs at :30/);
  assert.match(notificationSends.description, /precise-live sends can occur between ticks/);
  assert.match(notificationSends.description, /does not confirm handset delivery/);
  assert.match(notificationSends.description, /exact deltas from persisted counters/);
  const renderNotifications = new Function('context', notificationSends.options.getOption);
  const chart = renderNotifications({ panel: { data: {
    timeRange: {
      from: { valueOf: () => Date.parse('2026-10-09T17:24:18.325Z') },
      to: { valueOf: () => Date.parse('2026-10-10T17:35:30Z') },
    },
    series: [
      {
        refId: 'A',
        fields: [
          { type: 'time', values: [Date.parse('2026-10-10T17:25:00Z'), Date.parse('2026-10-10T17:30:30Z')] },
          { type: 'number', values: [0, 17] },
        ],
      },
      {
        refId: 'B',
        fields: [
          { type: 'time', values: [Date.parse('2026-10-10T17:25:00Z')] },
          { type: 'number', values: [0] },
        ],
      },
    ],
  } } });
  assert.equal(chart.series[0].name, 'accepted by FCM');
  assert.equal(chart.series[1].name, 'failed FCM send');
  assert.equal(chart.series[0].step, 'end');
  assert.ok(chart.series[0].data.some(([time, value]) => time === Date.parse('2026-10-10T17:30:30Z') && value === 17));
  assert.doesNotMatch(JSON.stringify(notificationSends.targets), /tubepulse_notifications_(sent|failed)\"/);
  assert.match(JSON.stringify(byTitle.get('Attention').targets), /tubepulse_notifications_durable_backlog/);

  const invalidTokens = byTitle.get('Invalid tokens · 24h');
  assert.equal(invalidTokens.type, 'volkovlabs-echarts-panel');
  assert.equal(invalidTokens.pluginVersion, '7.1.0');
  assert.equal(invalidTokens.transparent, true);
  assert.equal(invalidTokens.fieldConfig.defaults.color.fixedColor, '#4FC3F7');
  assert.deepEqual(invalidTokens.gridPos, { x: 18, y: 9, w: 6, h: 4 });
  assert.deepEqual(invalidTokens.targets, [{
    expr: 'tubepulse_notifications_invalid_token_events{event="cleanup"}',
    legendFormat: 'unique cleanup', refId: 'A', instant: true, range: false,
  }]);
  assert.match(invalidTokens.description, /not proof of an uninstall/);
  assert.match(invalidTokens.description, /normal lifecycle evidence rather than a service fault/);
  assert.doesNotMatch(JSON.stringify(status.targets), /invalid_token|dead_token/);
  assert.doesNotMatch(JSON.stringify(attention.targets), /invalid_token|dead_token/);
  const renderInvalidTokens = new Function('context', invalidTokens.options.getOption);
  assert.match(invalidTokens.options.getOption, /const valueSize = width < 210 \? 23 : width < 420 \? 32 : 38/);
  assert.match(invalidTokens.options.getOption, /const graphLeft = width < 210 \? '44%' : '40%'/);
  assert.match(invalidTokens.options.getOption, /xAxis: \{ type: 'time', show: true/);
  assert.match(invalidTokens.options.getOption, /splitNumber: width < 300 \? 2 : 3/);
  assert.match(invalidTokens.options.getOption, /width < 300 && index % 2 === 1/);
  const invalidChart = renderInvalidTokens({
    panel: {
      chart: { getWidth: () => 200 },
      data: {
        timeRange: {
          from: { valueOf: () => Date.parse('2026-10-09T18:00:00Z') },
          to: { valueOf: () => Date.parse('2026-10-10T18:00:00Z') },
        },
        series: [
          { fields: [{ type: 'number', labels: { bucket: '2026-10-09T17:55:00.000Z' }, values: [9] }] },
          { fields: [{ type: 'number', labels: { bucket: '2026-10-10T17:50:00.000Z' }, values: [1] }] },
          { fields: [{ type: 'number', labels: { bucket: '2026-10-10T17:55:00.000Z' }, values: [3] }] },
        ],
      },
    },
  });
  assert.equal(invalidChart.graphic[0].style.text, '4');
  assert.equal(invalidChart.xAxis.min, Date.parse('2026-10-09T18:00:00Z'));
  assert.equal(invalidChart.xAxis.max, Date.parse('2026-10-10T18:00:00Z'));
  assert.ok(invalidChart.series[0].data.some(([time, value]) => (
    time === Date.parse('2026-10-10T17:50:00Z') && value === 1
  )));
  assert.ok(invalidChart.series[0].data.some(([time, value]) => (
    time === Date.parse('2026-10-10T17:55:00Z') && value === 3
  )));
  assert.equal(invalidChart.series[0].data.some(([time]) => time < Date.parse('2026-10-09T18:00:00Z')), false);

  const invalidDiagnostics = new Map(
    JSON.parse(read('monitoring', 'grafana', 'dashboards', 'tubepulse-diagnostics.json'))
      .panels.map((panel) => [panel.title, panel]),
  ).get('Permanent invalid FCM tokens');
  assert.ok(invalidDiagnostics);
  assert.match(invalidDiagnostics.description, /not confirmed uninstalls or a health fault/);
  assert.deepEqual(invalidDiagnostics.targets.map(({ expr }) => expr), [
    'tubepulse_notifications_fcm_permanent_invalid_responses_total',
    'tubepulse_notifications_dead_token_cleanups_total',
  ]);

  const serialized = JSON.stringify(dashboard);
  for (const sensitive of ['deviceId', 'channelId', 'fcmToken', 'installationId']) {
    assert.doesNotMatch(serialized, new RegExp(sensitive, 'i'));
  }
});

test('wallboard coalesces only an absent Worker-error window without masking core telemetry', () => {
  const dashboard = JSON.parse(read('monitoring', 'grafana', 'dashboards', 'tubepulse-operations.json'));
  const byTitle = new Map(dashboard.panels.map((panel) => [panel.title, panel]));
  const statusExpr = byTitle.get('TubePulse status').targets[0].expr;
  const attentionTargets = byTitle.get('Attention').targets;
  const workerErrorTargets = attentionTargets.filter(({ expr }) => expr.includes('tubepulse_cloudflare_worker_errors'));
  const workerErrorFallback = 'sum(tubepulse_cloudflare_worker_errors{period="window"}) or vector(0)';

  assert.match(
    statusExpr,
    /scalar\(sum\(tubepulse_cloudflare_worker_errors\{period="window"\}\) or vector\(0\)\) == bool 0/,
    'an absent Worker-error window must be equivalent to zero during collector cold start',
  );
  assert.doesNotMatch(
    statusExpr,
    /scalar\(sum\(tubepulse_cloudflare_worker_errors\{period="window"\}\)\) == bool 0/,
    'the strict Worker-error sum would turn an absent series into a false core fault',
  );
  assert.ok(workerErrorTargets.length >= 3, 'attention must retain aggregate, actionable, and core Worker-error checks');
  for (const target of workerErrorTargets) {
    assert.ok(target.expr.includes(workerErrorFallback), `${target.legendFormat} must safely coalesce an absent Worker-error series`);
  }
  assert.match(statusExpr, /worker_errors[\s\S]*== bool 0/, 'a real nonzero Worker-error sum must still fail core health');
  assert.ok(
    workerErrorTargets.some(({ expr }) => /> bool 0|> 0/.test(expr)),
    'real nonzero Worker errors must remain actionable',
  );

  for (const metric of [
    'tubepulse_collector_collection_success',
    'tubepulse_collector_host_collection_success',
    'tubepulse_host_ready',
    'tubepulse_host_authority_current',
    'tubepulse_host_scheduler_active',
    'tubepulse_authority_backend_ready',
    'tubepulse_notifications_barrier_healthy',
  ]) {
    assert.ok(statusExpr.includes(metric), `${metric} must remain required for core health`);
    assert.doesNotMatch(
      statusExpr,
      new RegExp(`${metric}\\s*(?:or|\\|)\\s*vector\\(`),
      `${metric} must not be defaulted healthy when its telemetry is absent`,
    );
  }
  assert.match(statusExpr, /tubepulse_notifications_barrier_degraded == bool 0/);
  assert.ok(
    attentionTargets.some(({ expr }) => expr.includes('tubepulse_notifications_barrier_degraded')),
    'an isolated visibility mismatch must be attention without becoming a core fault',
  );
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
        notifications: {
          invalidTokenEvents: [{
            bucket: '2026-10-06T00:00:00.000Z', permanentResponses: 1, uniqueCleanups: 1,
          }],
        }, authority: { estimatedRows: {}, limits: {} },
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
  assert.match(compose, /GF_PLUGINS_PREINSTALL_SYNC:\s*volkovlabs-echarts-panel@7\.1\.0/);
  assert.doesNotMatch(compose, /volkovlabs-echarts-panel@(latest|7\.2\.)/);
  assert.match(compose, /retention\.size=5GB/);
  assert.doesNotMatch(compose, /TUBEPULSE_NOTIFICATION_BACKFILL_FILE/);
  assert.doesNotMatch(read('monitoring', 'Dockerfile'), /COPY backfill/);
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
  const invocations = [...source.matchAll(/Start-MonitoringBestEffort/g)].map(({ index }) => index);
  assert.equal(invocations.length, 2, 'monitoring helper should have one definition and one invocation');
  const invocation = invocations.at(-1);
  const successGuard = source.lastIndexOf('if ($evaluation.Success)', invocation);
  assert.ok(successGuard >= 0 && successGuard < invocation, 'monitoring startup must remain in the successful authority path');
  assert.match(
    source.slice(invocation - 200, invocation + 100),
    /Write-SupervisorLog[^\n]+\$evaluation\.Message\s+Start-MonitoringBestEffort\s+exit 0/,
  );
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
