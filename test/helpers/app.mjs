// Starts the real server as its own process for the end-to-end tests:
// demo mode, a throwaway data directory, a port nobody else is on.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

export function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

export async function startApp({ demo = true, env = {}, timeoutMs = 20_000 } = {}) {
  const port = await freePort();
  const key = `test-${Math.random().toString(16).slice(2, 10)}`;
  const dataDir = mkdtempSync(join(tmpdir(), 'matched-in-e2e-'));

  const child = spawn(process.execPath, [join(ROOT, 'server/server.mjs')], {
    env: { ...process.env, PORT: String(port), SWIPE_KEY: key, DATA_DIR: dataDir, DEMO: demo ? '1' : '0', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + timeoutMs;
  let ready = false;
  while (Date.now() < deadline && !ready) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode}):\n${output}`);
    try {
      const res = await fetch(`${base}/api/state?k=${key}`);
      ready = res.ok;
    } catch { /* not listening yet */ }
    if (!ready) await new Promise((r) => setTimeout(r, 150));
  }
  if (!ready) {
    child.kill('SIGKILL');
    throw new Error(`server did not come up in ${timeoutMs}ms:\n${output}`);
  }

  const api = async (path, { method = 'GET', body } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'x-swipe-key': key, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* html or plain text */ }
    return { status: res.status, body: json, text };
  };

  return {
    base, key, port, dataDir, api,
    url: (path = '/') => `${base}${path}`,
    output: () => output,
    async stop() {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await Promise.race([once(child, 'exit'), new Promise((r) => setTimeout(r, 3000))]);
        if (child.exitCode === null) child.kill('SIGKILL');
      }
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
