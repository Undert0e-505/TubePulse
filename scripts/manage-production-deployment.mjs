#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const defaultRepoRoot = path.resolve(path.dirname(scriptPath), '..');
const SCHEMA_VERSION = 1;

function fail(message) { throw new Error(message); }
function slash(value) { return path.resolve(value).replaceAll('\\', '/'); }
function yaml(value) { return JSON.stringify(String(value)); }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

function run(command, args, { cwd = defaultRepoRoot, allowFailure = false } = {}) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', windowsHide: true });
  if (!allowFailure && result.status !== 0) {
    fail(`${command} ${args.join(' ')} failed: ${(result.stderr || result.stdout || '').trim().slice(0, 500)}`);
  }
  return result;
}

async function atomicJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally { await handle.close(); }
  await fs.rename(temporary, filePath);
}

async function files(directory) {
  const result = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(absolute));
    else if (entry.isFile()) result.push(absolute);
  }
  return result;
}

export async function hashDirectory(directory) {
  const entries = [];
  for (const file of (await files(directory)).sort()) {
    const relative = path.relative(directory, file).replaceAll('\\', '/');
    entries.push(`${relative}\0${sha256(await fs.readFile(file))}\n`);
  }
  return sha256(entries.join(''));
}

async function sourceEvidence(repoRoot) {
  const commit = run('git', ['rev-parse', 'HEAD'], { cwd: repoRoot }).stdout.trim();
  const status = run('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: repoRoot }).stdout;
  const names = run('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: repoRoot })
    .stdout.split('\0').filter(Boolean).sort();
  const hashes = [];
  for (const name of names) {
    const absolute = path.join(repoRoot, name);
    const stat = await fs.stat(absolute).catch(() => null);
    if (stat?.isFile()) hashes.push(`${name.replaceAll('\\', '/')}\0${sha256(await fs.readFile(absolute))}\n`);
  }
  return { commit, treeHash: sha256(hashes.join('')), dirty: status.trim().length > 0 };
}

function inspectImage(reference) {
  const result = run('docker', ['image', 'inspect', reference, '--format', '{{.Id}}']);
  const id = result.stdout.trim();
  if (!/^sha256:[a-f0-9]{64}$/.test(id)) fail(`Cannot resolve immutable image ID for ${reference}`);
  return id;
}

function tagCandidate(source, target) {
  run('docker', ['image', 'tag', source, target]);
  return inspectImage(target);
}

function readBindAddress(text) {
  const match = text.match(/^\s*TUBEPULSE_MONITORING_GRAFANA_BIND_ADDRESS\s*=\s*(\S+)\s*$/m);
  const value = match?.[1] || '127.0.0.1';
  if (!['127.0.0.1', '0.0.0.0'].includes(value)) fail('Grafana bind address is not approved');
  return value;
}

function homeCompose({ repoRoot, homeTag }) {
  const selfHost = slash(path.join(repoRoot, 'self-host'));
  return `name: tubepulse-home-authority
services:
  home-authority:
    image: ${yaml(homeTag)}
    pull_policy: never
    command: ["node", "src/home-authority-cli.mjs", "run"]
    restart: unless-stopped
    stop_signal: SIGUSR2
    stop_grace_period: 4m
    env_file:
      - path: ${yaml(`${selfHost}/.env.authority`)}
        required: true
    environment:
      TUBEPULSE_HOME_SCHEDULER_DATA_DIR: /data
      TUBEPULSE_HOME_AUTHORITY_HOST: 0.0.0.0
      TUBEPULSE_HOME_AUTHORITY_PORT: 8788
    ports: ["127.0.0.1:8789:8788"]
    volumes:
      - ${yaml(`${selfHost}/data-authority:/data`)}
      - ${yaml(`${selfHost}/secrets/cloudflare-scheduler-write-token.txt:/run/secrets/tubepulse/cloudflare-token.txt:ro`)}
      - ${yaml(`${selfHost}/secrets/firebase.json:/run/secrets/tubepulse/firebase.json:ro`)}
      - ${yaml(`${selfHost}/secrets/youtube-api-key.txt:/run/secrets/tubepulse/youtube-api-key.txt:ro`)}
      - ${yaml(`${selfHost}/secrets/authority-secret.txt:/run/secrets/tubepulse/authority-secret.txt:ro`)}
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:8788/_tubepulse/status').then(async r=>{const j=await r.json();if(!r.ok||j.service!=='unified-home-authority')process.exit(1)}).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 10s
      start_period: 20s
      retries: 3
    networks:
      home-private:
        aliases: [gateway-origin]
  cloudflared:
    image: cloudflare/cloudflared@sha256:c6c7ae1d5dfdcb094ad344ed68ccffc26635c9c6be80965664c33baf064b0515
    pull_policy: never
    restart: unless-stopped
    command: ["tunnel", "--no-autoupdate", "--loglevel", "info", "run", "--token-file", "/run/secrets/cloudflared-tunnel-token"]
    read_only: true
    cap_drop: ["ALL"]
    security_opt: ["no-new-privileges:true"]
    volumes: [${yaml(`${selfHost}/secrets/cloudflared-tunnel-token.txt:/run/secrets/cloudflared-tunnel-token:ro`)}]
    depends_on:
      home-authority: { condition: service_healthy }
    networks: [home-private]
networks:
  home-private: { driver: bridge }
`;
}

function monitoringCompose({ repoRoot, bundle, collectorTag, grafanaBind }) {
  const root = slash(repoRoot);
  const config = slash(path.join(bundle, 'monitoring'));
  return `name: tubepulse-monitoring
services:
  collector:
    image: ${yaml(collectorTag)}
    pull_policy: never
    restart: unless-stopped
    environment:
      CLOUDFLARE_ACCOUNT_ID: 77bb7769185bbfeb53feef16b9f72803
      CLOUDFLARE_D1_DATABASE_ID: bc49a996-5576-4000-8cf5-b104c2bb7e84
      CLOUDFLARE_WORKER_SCRIPT: tubepulse-api
      CLOUDFLARE_API_TOKEN_FILE: /run/secrets/cloudflare-read-token.txt
      TUBEPULSE_HOST_MONITORING_URL: http://home-authority:8788/_tubepulse/monitoring
      TUBEPULSE_SNAPSHOT_DIR: /data/snapshots
      TUBEPULSE_COLLECTOR_STATE_FILE: /data/collector/state.json
      TUBEPULSE_SNAPSHOT_RETENTION_DAYS: 1095
      TUBEPULSE_SCHEDULER_SETTLEMENT_TIMEOUT_MS: 90000
      TUBEPULSE_D1_ROWS_WRITTEN_GUARDRAIL: 100000
      TUBEPULSE_D1_ROWS_READ_GUARDRAIL: 5000000
      TUBEPULSE_DO_ROWS_WRITTEN_GUARDRAIL: 100000
      TUBEPULSE_DO_REQUEST_GUARDRAIL: 100000
      TUBEPULSE_DO_REQUEST_SAFE_TARGET: 90000
      TUBEPULSE_WORKER_REQUEST_GUARDRAIL: 100000
    ports: ["127.0.0.1:9464:9464"]
    volumes:
      - ${yaml(`${root}/self-host/secrets/cloudflare-read-token.txt:/run/secrets/cloudflare-read-token.txt:ro`)}
      - ${yaml(`${root}/logs/snapshots:/data/snapshots`)}
      - ${yaml(`${root}/logs/collector:/data/collector`)}
    networks: [monitoring, authority]
    healthcheck:
      test: ["CMD", "wget", "-q", "-O", "-", "http://127.0.0.1:9464/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 15s
  prometheus:
    image: prom/prometheus:v3.7.1@sha256:ff7e389acbe064a4823212a500393d40a28a8f362e4b05cbf6742a9a3ef736b2
    pull_policy: never
    restart: unless-stopped
    command: ["--config.file=/etc/prometheus/prometheus.yml", "--storage.tsdb.path=/prometheus", "--storage.tsdb.retention.time=5y", "--storage.tsdb.retention.size=5GB", "--web.enable-lifecycle"]
    ports: ["127.0.0.1:9090:9090"]
    volumes:
      - ${yaml(`${config}/prometheus/prometheus.yml:/etc/prometheus/prometheus.yml:ro`)}
      - ${yaml(`${config}/prometheus/rules.yml:/etc/prometheus/rules.yml:ro`)}
      - ${yaml(`${root}/logs/prometheus:/prometheus`)}
    networks: [monitoring]
    depends_on:
      collector: { condition: service_healthy }
    healthcheck:
      test: ["CMD", "wget", "-q", "-O", "-", "http://127.0.0.1:9090/-/ready"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 15s
  grafana:
    image: grafana/grafana:12.2.0@sha256:74144189b38447facf737dfd0f3906e42e0776212bf575dc3334c3609183adf7
    pull_policy: never
    restart: unless-stopped
    environment:
      GF_AUTH_ANONYMOUS_ENABLED: "true"
      GF_AUTH_ANONYMOUS_ORG_ROLE: Viewer
      GF_AUTH_DISABLE_LOGIN_FORM: "true"
      GF_USERS_ALLOW_SIGN_UP: "false"
      GF_DASHBOARDS_DEFAULT_HOME_DASHBOARD_PATH: /etc/grafana/dashboards/tubepulse-operations.json
      GF_ANALYTICS_REPORTING_ENABLED: "false"
      GF_ANALYTICS_CHECK_FOR_UPDATES: "false"
      GF_PLUGINS_PREINSTALL_SYNC: volkovlabs-echarts-panel@7.1.0
    ports: [${yaml(`${grafanaBind}:3000:3000`)}]
    volumes:
      - ${yaml(`${config}/grafana/provisioning:/etc/grafana/provisioning:ro`)}
      - ${yaml(`${config}/grafana/dashboards:/etc/grafana/dashboards:ro`)}
      - ${yaml(`${root}/logs/grafana:/var/lib/grafana`)}
    networks: [monitoring]
    depends_on:
      prometheus: { condition: service_healthy }
    healthcheck:
      test: ["CMD", "wget", "-q", "-O", "-", "http://127.0.0.1:3000/api/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 15s
networks:
  monitoring: { driver: bridge }
  authority:
    name: tubepulse-home-authority_home-private
    external: true
`;
}

export async function validateManifestFiles(manifest) {
  if (manifest?.schemaVersion !== SCHEMA_VERSION) fail('Unsupported deployment manifest schema');
  const bundle = path.resolve(manifest.bundle.path);
  if (await hashDirectory(bundle) !== manifest.bundle.sha256) fail('Deployment bundle hash mismatch');
  for (const component of ['home', 'monitoring']) {
    const compose = path.resolve(manifest[component].composeFile);
    if (sha256(await fs.readFile(compose)) !== manifest[component].composeSha256) {
      fail(`${component} Compose hash mismatch`);
    }
  }
  return manifest;
}

async function readManifest(repoRoot, manifestPath) {
  const resolved = manifestPath || path.join(repoRoot, 'logs', 'deployments', 'production', 'current.json');
  const manifest = JSON.parse(await fs.readFile(resolved, 'utf8'));
  await validateManifestFiles(manifest);
  return { manifest, manifestPath: path.resolve(resolved) };
}

function verifyImages(manifest) {
  for (const [name, image] of Object.entries(manifest.images)) {
    if (inspectImage(image.reference) !== image.id) fail(`Pinned ${name} image no longer resolves to its promoted ID`);
  }
}

function inspectContainer(name) {
  const result = run('docker', ['inspect', name, '--format', '{{json .}}']);
  return JSON.parse(result.stdout);
}

function verifyRunning(manifest, component) {
  const expectations = component === 'home'
    ? { 'tubepulse-home-authority-home-authority-1': manifest.images.home.id }
    : {
      'tubepulse-monitoring-collector-1': manifest.images.collector.id,
      'tubepulse-monitoring-prometheus-1': manifest.images.prometheus.id,
      'tubepulse-monitoring-grafana-1': manifest.images.grafana.id,
    };
  for (const [name, expected] of Object.entries(expectations)) {
    const container = inspectContainer(name);
    if (container.Image !== expected) fail(`${name} image mismatch: expected ${expected}, found ${container.Image}`);
    if (container.State?.Running !== true) fail(`${name} is not running`);
  }
  if (component === 'monitoring') {
    const prometheus = inspectContainer('tubepulse-monitoring-prometheus-1');
    const grafana = inspectContainer('tubepulse-monitoring-grafana-1');
    const mounts = [...prometheus.Mounts, ...grafana.Mounts].filter((mount) => mount.Destination.startsWith('/etc/'));
    if (mounts.some((mount) => !slash(mount.Source).startsWith(`${slash(manifest.bundle.path)}/`))) {
      fail('Monitoring configuration is not mounted from the promoted immutable bundle');
    }
    const port = grafana.NetworkSettings?.Ports?.['3000/tcp']?.[0];
    if (port?.HostIp !== manifest.monitoring.grafanaBindAddress) fail('Grafana LAN binding differs from the manifest');
  }
}

export async function promoteManifest(root, manifest) {
  const current = path.join(root, 'current.json');
  const previous = path.join(root, 'previous.json');
  const history = path.join(root, 'history', `${manifest.deploymentId}.json`);
  const old = await fs.readFile(current, 'utf8').catch(() => null);
  if (old) await atomicJson(previous, JSON.parse(old));
  await atomicJson(history, manifest);
  await atomicJson(current, manifest);
}

async function assemble({ repoRoot, id, homeImage, collectorImage, evidencePath, monitoringConfig, promote }) {
  if (!/^[a-zA-Z0-9._-]{3,80}$/.test(id)) fail('Deployment ID is invalid');
  const evidence = JSON.parse(await fs.readFile(path.resolve(evidencePath), 'utf8'));
  if (evidence.passed !== true || !Array.isArray(evidence.commands) || evidence.commands.length === 0) {
    fail('Test evidence must explicitly record passed=true and at least one command');
  }
  const production = path.join(repoRoot, 'logs', 'deployments', 'production');
  const destination = path.join(production, 'bundles', id);
  await fs.access(destination).then(() => fail(`Deployment bundle already exists: ${id}`)).catch((error) => {
    if (error?.code !== 'ENOENT') throw error;
  });
  const temporary = `${destination}.tmp-${process.pid}-${crypto.randomUUID()}`;
  await fs.mkdir(path.join(temporary, 'monitoring'), { recursive: true });
  const safe = id.toLowerCase().replace(/[^a-z0-9_.-]/g, '-');
  const homeTag = `tubepulse-home-authority-home-authority:deployment-${safe}`;
  const collectorTag = `tubepulse-monitoring-collector:deployment-${safe}`;
  const homeId = tagCandidate(homeImage, homeTag);
  const collectorId = tagCandidate(collectorImage, collectorTag);
  const monitoringSource = monitoringConfig ? path.resolve(monitoringConfig) : path.join(repoRoot, 'monitoring');
  await fs.cp(path.join(monitoringSource, 'prometheus'), path.join(temporary, 'monitoring', 'prometheus'), { recursive: true });
  await fs.cp(path.join(monitoringSource, 'grafana'), path.join(temporary, 'monitoring', 'grafana'), { recursive: true });
  await fs.copyFile(path.resolve(evidencePath), path.join(temporary, 'test-evidence.json'));
  const envText = await fs.readFile(path.join(repoRoot, 'monitoring', '.env.local'), 'utf8').catch(() => '');
  const grafanaBindAddress = readBindAddress(envText);
  const homeComposePath = path.join(temporary, 'compose.home.yaml');
  const monitoringComposePath = path.join(temporary, 'compose.monitoring.yaml');
  await fs.writeFile(homeComposePath, homeCompose({ repoRoot, homeTag }), 'utf8');
  await fs.writeFile(monitoringComposePath, monitoringCompose({
    repoRoot, bundle: destination, collectorTag, grafanaBind: grafanaBindAddress,
  }), 'utf8');
  await fs.rename(temporary, destination);
  const source = await sourceEvidence(repoRoot);
  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    deploymentId: id,
    promotedAt: new Date().toISOString(),
    source,
    tests: { passed: true, evidenceFile: path.join(destination, 'test-evidence.json'), sha256: sha256(await fs.readFile(path.join(destination, 'test-evidence.json'))) },
    bundle: { path: destination, sha256: await hashDirectory(destination) },
    home: { composeFile: path.join(destination, 'compose.home.yaml'), composeSha256: sha256(await fs.readFile(path.join(destination, 'compose.home.yaml'))) },
    monitoring: {
      composeFile: path.join(destination, 'compose.monitoring.yaml'),
      composeSha256: sha256(await fs.readFile(path.join(destination, 'compose.monitoring.yaml'))),
      grafanaBindAddress,
    },
    images: {
      home: { reference: homeTag, id: homeId },
      collector: { reference: collectorTag, id: collectorId },
      prometheus: { reference: 'prom/prometheus:v3.7.1@sha256:ff7e389acbe064a4823212a500393d40a28a8f362e4b05cbf6742a9a3ef736b2', id: inspectImage('prom/prometheus:v3.7.1@sha256:ff7e389acbe064a4823212a500393d40a28a8f362e4b05cbf6742a9a3ef736b2') },
      grafana: { reference: 'grafana/grafana:12.2.0@sha256:74144189b38447facf737dfd0f3906e42e0776212bf575dc3334c3609183adf7', id: inspectImage('grafana/grafana:12.2.0@sha256:74144189b38447facf737dfd0f3906e42e0776212bf575dc3334c3609183adf7') },
    },
  };
  await validateManifestFiles(manifest);
  if (promote) await promoteManifest(production, manifest);
  return manifest;
}

function parseArgs(argv) {
  const result = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) result._.push(argv[i]);
    else if (argv[i] === '--promote' || argv[i] === '--skip-images') result[argv[i].slice(2)] = true;
    else result[argv[i].slice(2)] = argv[++i];
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [command] = args._;
  const repoRoot = path.resolve(args.repo || defaultRepoRoot);
  if (command === 'assemble') return await assemble({
    repoRoot, id: args.id, homeImage: args['home-image'], collectorImage: args['collector-image'],
    evidencePath: args.evidence, monitoringConfig: args['monitoring-config'], promote: args.promote === true,
  });
  if (command === 'verify' || command === 'verify-running') {
    const { manifest, manifestPath } = await readManifest(repoRoot, args.manifest);
    if (!args['skip-images']) verifyImages(manifest);
    if (command === 'verify-running') verifyRunning(manifest, args.component);
    return {
      ok: true, manifestPath, deploymentId: manifest.deploymentId,
      composeFile: manifest[args.component]?.composeFile,
      expectedImageId: manifest.images[args.component === 'home' ? 'home' : 'collector']?.id,
      bundlePath: manifest.bundle.path,
      bundleSha256: manifest.bundle.sha256,
      grafanaBindAddress: manifest.monitoring.grafanaBindAddress,
    };
  }
  if (command === 'rollback') {
    const production = path.join(repoRoot, 'logs', 'deployments', 'production');
    const currentPath = path.join(production, 'current.json');
    const previousPath = path.join(production, 'previous.json');
    const current = JSON.parse(await fs.readFile(currentPath, 'utf8'));
    const previous = JSON.parse(await fs.readFile(previousPath, 'utf8'));
    await validateManifestFiles(previous);
    verifyImages(previous);
    await atomicJson(previousPath, current);
    await atomicJson(currentPath, previous);
    return { ok: true, deploymentId: previous.deploymentId, rolledBackFrom: current.deploymentId };
  }
  fail('Usage: assemble|verify|verify-running|rollback');
}

if (path.resolve(process.argv[1] || '') === scriptPath) {
  main().then((value) => console.log(JSON.stringify(value)), (error) => {
    console.error(error?.message || error);
    process.exitCode = 1;
  });
}
