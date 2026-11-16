// Launches a dedicated Chrome profile with remote debugging and talks to it over CDP.
// A dedicated profile means we never fight with the Chrome you use day to day.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { createConnection } from 'node:net';
import { dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
];

export function findChrome() {
  const fromEnv = process.env.CHROME_BIN;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  return CHROME_PATHS.find(existsSync) || null;
}

/** One JSON-RPC connection to a CDP target. */
class CdpSocket {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.ws = null;
  }

  async open() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', () => reject(new Error('CDP socket failed to open')), { once: true });
    });
    this.ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      const slot = this.pending.get(msg.id);
      if (!slot) return;
      this.pending.delete(msg.id);
      if (msg.error) slot.reject(new Error(`${msg.error.message} (${msg.error.code})`));
      else slot.resolve(msg.result);
    });
    this.ws.addEventListener('close', () => {
      for (const slot of this.pending.values()) slot.reject(new Error('CDP socket closed'));
      this.pending.clear();
      this.ws = null;
    });
  }

  get connected() { return this.ws && this.ws.readyState === 1; }

  send(method, params = {}) {
    if (!this.connected) return Promise.reject(new Error('CDP not connected'));
    const id = this.nextId++;
    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP timeout: ${method}`));
      }, 45_000);
    });
    this.ws.send(JSON.stringify({ id, method, params }));
    return promise;
  }

  close() { try { this.ws?.close(); } catch { /* already gone */ } }
}

/** True if anything at all holds the TCP port — CDP or not. */
function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function portBusy(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const done = (busy) => { socket.destroy(); resolve(busy); };
    socket.setTimeout(700);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

async function httpJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

export class Browser {
  constructor({ port, userDataDir, startUrl }) {
    this.port = port;
    this.userDataDir = userDataDir;
    this.startUrl = startUrl;
    this.proc = null;
    this.page = null;        // CdpSocket bound to the LinkedIn tab
    this.targetId = null;
  }

  get base() { return `http://127.0.0.1:${this.port}`; }

  async isUp() {
    try { await httpJson(`${this.base}/json/version`); return true; }
    catch { return false; }
  }

  get lockFile() { return `${this.userDataDir}.lock`; }

  readLock() {
    try { return JSON.parse(readFileSync(this.lockFile, 'utf8')); }
    catch { return null; }
  }

  writeLock(port, pid) {
    mkdirSync(dirname(this.lockFile), { recursive: true });
    writeFileSync(this.lockFile, JSON.stringify({ port, pid, at: Date.now() }));
  }

  /**
   * Reuse the Chrome we started earlier, otherwise start one on a free port.
   *
   * Ownership comes from a lock file rather than from inspecting the browser:
   * Chrome does not reliably answer Browser.getBrowserCommandLine, and other
   * Chromium browsers (Vivaldi, Brave, Edge) may hold the default port 9222.
   * Getting this wrong is costly in both directions — we would either drive
   * somebody else's browser, or try to start a second Chrome on a profile that
   * is already open, which silently hands off and never opens a debug port.
   */
  async launch() {
    const lock = this.readLock();
    if (lock?.port && await portBusy(lock.port)) {
      const alive = lock.pid ? isAlive(lock.pid) : true;
      this.port = lock.port;
      if (alive && await this.isUp()) return { launched: false, port: lock.port, reused: true };
    }

    const bin = findChrome();
    if (!bin) throw new Error('Chrome not found. Install Google Chrome or set CHROME_BIN.');

    const skipped = [];
    for (let port = this.port; port < this.port + 20; port++) {
      if (await portBusy(port)) { skipped.push(port); continue; }

      this.port = port;
      const proc = spawn(bin, [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${this.userDataDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-features=Translate,MediaRouter',
        '--restore-last-session=false',
        this.startUrl,
      ], { detached: true, stdio: 'ignore' });
      this.proc = proc;
      proc.unref();

      let exited = false;
      proc.once('exit', () => { exited = true; });

      for (let i = 0; i < 60; i++) {
        await sleep(500);
        if (await this.isUp()) {
          this.writeLock(port, proc.pid);
          return { launched: true, port, skipped };
        }
        // Chrome exits at once when this profile is already open in another window.
        if (exited && i > 4) {
          throw new Error(
            `A Chrome is already using ${this.userDataDir}. Quit that window and start again.`,
          );
        }
      }
      throw new Error(`Chrome did not expose debugging port ${port} in time.`);
    }

    throw new Error(`Ports ${this.port}-${this.port + 19} are all in use.`);
  }

  forgetLock() { try { rmSync(this.lockFile); } catch { /* nothing to clear */ } }

  async listTargets() {
    const all = await httpJson(`${this.base}/json/list`);
    return all.filter((t) => t.type === 'page');
  }

  /** Attach to a LinkedIn tab, creating or reusing one. */
  async attach() {
    if (this.page?.connected) return this.page;
    const pages = await this.listTargets();
    let target = pages.find((t) => (t.url || '').includes('linkedin.com'));
    if (!target) {
      // /json/new is blocked on newer Chrome unless we ask with PUT.
      await fetch(`${this.base}/json/new?${encodeURIComponent(this.startUrl)}`, { method: 'PUT' })
        .catch(() => {});
      await sleep(1200);
      const again = await this.listTargets();
      target = again.find((t) => (t.url || '').includes('linkedin.com')) || again[0];
    }
    if (!target?.webSocketDebuggerUrl) throw new Error('No debuggable Chrome tab available.');
    this.targetId = target.id;
    this.page = new CdpSocket(target.webSocketDebuggerUrl);
    await this.page.open();
    await this.page.send('Page.enable').catch(() => {});
    await this.page.send('Runtime.enable').catch(() => {});
    await this.page.send('Network.enable').catch(() => {});
    return this.page;
  }

  async currentUrl() {
    const page = await this.attach();
    const { result } = await page.send('Runtime.evaluate', {
      expression: 'location.href', returnByValue: true,
    });
    return result.value;
  }

  /** Evaluate JS in the page and return its value. Supports top-level await. */
  async evaluate(expression) {
    const page = await this.attach();
    const { result, exceptionDetails } = await page.send('Runtime.evaluate', {
      expression: `(async () => { ${expression} })()`,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (exceptionDetails) {
      throw new Error(exceptionDetails.exception?.description || exceptionDetails.text || 'Page script failed');
    }
    return result.value;
  }

  async navigate(url, { waitMs = 3500 } = {}) {
    const page = await this.attach();
    await page.send('Page.navigate', { url });
    await sleep(waitMs);
  }

  async setCookie(name, value, domain = '.www.linkedin.com') {
    const page = await this.attach();
    await page.send('Network.setCookie', {
      name, value, domain, path: '/', secure: true, httpOnly: true, sameSite: 'None',
    });
  }

  async cookieNames() {
    const page = await this.attach();
    const { cookies } = await page.send('Network.getCookies', { urls: ['https://www.linkedin.com/'] });
    return cookies.map((c) => c.name);
  }

  /**
   * Click at viewport coordinates with real, trusted input events.
   * element.click() would be isTrusted:false; dispatched CDP input is not.
   */
  async clickAt(x, y) {
    const page = await this.attach();
    const common = { x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 };
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: common.x, y: common.y });
    await sleep(40 + Math.random() * 90);
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...common });
    await sleep(40 + Math.random() * 70);
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...common });
  }

  close() { this.page?.close(); }
}
