import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  hashDirectory,
  promoteManifest,
  validateManifestFiles,
} from '../../scripts/manage-production-deployment.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tubepulse-deployment-'));
  t.after(async () => await fs.rm(root, { recursive: true, force: true }));
  const bundle = path.join(root, 'bundle');
  await fs.mkdir(bundle);
  const home = path.join(bundle, 'home.yaml');
  const monitoring = path.join(bundle, 'monitoring.yaml');
  await fs.writeFile(home, 'services: {}\n');
  await fs.writeFile(monitoring, 'services: {}\n');
  const crypto = await import('node:crypto');
  const digest = async (file) => crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
  const manifest = {
    schemaVersion: 1, deploymentId: 'test', bundle: { path: bundle, sha256: await hashDirectory(bundle) },
    home: { composeFile: home, composeSha256: await digest(home) },
    monitoring: { composeFile: monitoring, composeSha256: await digest(monitoring) },
  };
  return { root, bundle, home, monitoring, manifest };
}

test('immutable deployment verification detects any config mutation', async (t) => {
  const value = await fixture(t);
  await validateManifestFiles(value.manifest);
  await fs.appendFile(value.monitoring, '# dirty reboot edit\n');
  await assert.rejects(() => validateManifestFiles(value.manifest), /bundle hash mismatch/);
});

test('promotion atomically retains the prior manifest for rollback', async (t) => {
  const { root, manifest } = await fixture(t);
  const production = path.join(root, 'production');
  await promoteManifest(production, { ...manifest, deploymentId: 'one' });
  await promoteManifest(production, { ...manifest, deploymentId: 'two' });
  assert.equal(JSON.parse(await fs.readFile(path.join(production, 'current.json'))).deploymentId, 'two');
  assert.equal(JSON.parse(await fs.readFile(path.join(production, 'previous.json'))).deploymentId, 'one');
  assert.equal(JSON.parse(await fs.readFile(path.join(production, 'history', 'one.json'))).deploymentId, 'one');
  assert.equal(JSON.parse(await fs.readFile(path.join(production, 'history', 'two.json'))).deploymentId, 'two');
});
