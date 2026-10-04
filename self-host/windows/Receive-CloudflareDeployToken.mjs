#!/usr/bin/env node

import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdir, open, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const windowsDir = path.dirname(fileURLToPath(import.meta.url));
const selfHostDir = path.resolve(windowsDir, '..');
const repoRoot = path.resolve(selfHostDir, '..');
const secretDir = path.resolve(selfHostDir, 'secrets');
const destination = path.resolve(secretDir, 'cloudflare-authority-deploy-token.txt');
const nonce = randomBytes(24).toString('base64url');
const timeoutMs = 10 * 60 * 1000;

if (path.dirname(destination) !== secretDir) {
  throw new Error('Deploy-token destination escaped self-host/secrets.');
}

function send(response, status, contentType, body) {
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'",
    'Content-Type': contentType,
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(body);
}

function page(port) {
  return `<!doctype html><meta charset="utf-8"><title>Store TubePulse deploy token</title>
<style>body{font:16px system-ui;max-width:42rem;margin:4rem auto;padding:0 1rem}input{width:100%;padding:.6rem}button{margin-top:1rem;padding:.6rem 1rem}</style>
<h1>Store TubePulse deploy token</h1>
<p>This one-time loopback form writes the token to the ignored TubePulse secret file and then closes.</p>
<form method="post" action="http://127.0.0.1:${port}/store?nonce=${nonce}" autocomplete="off">
<label>Cloudflare API token<input name="token" type="password" required minlength="32" maxlength="512" autocomplete="off"></label>
<button type="submit">Store securely</button></form>`;
}

async function readBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 2048) throw new Error('Request body is too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function storeToken(token) {
  if (!/^[A-Za-z0-9._~-]{32,512}$/.test(token)) {
    throw new Error('Submitted value is not a plausible Cloudflare API token.');
  }
  await mkdir(secretDir, { recursive: true });
  const handle = await open(destination, 'wx', 0o600);
  try {
    await handle.writeFile(token, { encoding: 'utf8' });
  } catch (error) {
    await handle.close().catch(() => {});
    await rm(destination, { force: true }).catch(() => {});
    throw error;
  }
  await handle.close();

  const identity = `${process.env.USERDOMAIN ?? ''}\\${process.env.USERNAME ?? ''}`;
  const acl = spawnSync('icacls.exe', [
    destination,
    '/inheritance:r',
    '/grant:r',
    `${identity}:(F)`,
    '*S-1-5-18:(F)',
    '*S-1-5-32-544:(F)',
  ], { encoding: 'utf8', windowsHide: true });
  if (acl.status !== 0) {
    await rm(destination, { force: true });
    throw new Error('Unable to apply a restrictive ACL to the deploy-token file.');
  }

  const ignored = spawnSync('git.exe', [
    '-C', repoRoot, 'check-ignore', '--no-index', '--quiet', '--', destination,
  ], { encoding: 'utf8', windowsHide: true });
  if (ignored.status !== 0) {
    await rm(destination, { force: true });
    throw new Error('Deploy-token file is not ignored by Git.');
  }
}

let stored = false;
const server = createServer(async (request, response) => {
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const url = new URL(request.url ?? '/', origin);
    if (url.searchParams.get('nonce') !== nonce) {
      return send(response, 404, 'text/plain; charset=utf-8', 'Not found');
    }
    if (request.method === 'GET' && url.pathname === '/') {
      return send(response, 200, 'text/html; charset=utf-8', page(server.address().port));
    }
    if (request.method !== 'POST' || url.pathname !== '/store' || stored) {
      return send(response, 405, 'text/plain; charset=utf-8', 'Method not allowed');
    }
    const contentType = request.headers['content-type'] ?? '';
    if (!contentType.startsWith('application/x-www-form-urlencoded')) {
      return send(response, 415, 'text/plain; charset=utf-8', 'Unsupported content type');
    }
    const body = new URLSearchParams(await readBody(request));
    await storeToken((body.get('token') ?? '').trim());
    stored = true;
    send(response, 200, 'text/html; charset=utf-8',
      '<!doctype html><meta charset="utf-8"><title>Stored</title><h1>Token stored securely</h1><p>You may close this tab.</p>');
    setImmediate(() => server.close());
  } catch (error) {
    send(response, 400, 'text/plain; charset=utf-8', error.message);
    setImmediate(() => server.close());
  }
});

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  console.log(JSON.stringify({
    ready: true,
    url: `http://127.0.0.1:${port}/?nonce=${nonce}`,
    destination,
    secretPrinted: false,
  }));
});

const timer = setTimeout(() => server.close(), timeoutMs);
timer.unref();
server.on('close', () => process.exitCode = stored ? 0 : 1);
