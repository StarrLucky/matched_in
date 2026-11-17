// Local HTTP server: serves the swipe app to your phone and drives Chrome for it.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

import { Browser } from './chrome.mjs';
import { LinkedIn, FEED_URL } from './linkedin.mjs';
import { Store } from './store.mjs';
import { DEMO_CARDS } from './demo.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PUBLIC = join(ROOT, 'public');
// DATA_DIR lets the end-to-end tests run against a throwaway profile and
// history instead of yours.
const DATA = process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : join(ROOT, 'data');

const PORT = Number(process.env.PORT || 7777);
const CDP_PORT = Number(process.env.CDP_PORT || 9222);
// Anyone on your Wi-Fi could otherwise send invites from your account.
const KEY = process.env.SWIPE_KEY || randomBytes(6).toString('hex');
// Demo mode exercises the whole app with fixtures and never opens LinkedIn.
const DEMO = process.env.DEMO === '1';

const store = new Store(join(DATA, 'state.json'));
const browser = new Browser({
  port: CDP_PORT,
  userDataDir: join(DATA, 'chrome-profile'),
  startUrl: FEED_URL,
});
const linkedin = new LinkedIn(browser);

// Chrome is a single resource; never let two requests drive it at once.
let chain = Promise.resolve();
const exclusive = (fn) => {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
};

// In-memory deck buffer so swiping does not re-scrape on every card.
let buffer = [];

/** Chrome may have been quit since startup; bring it back before using it. */
async function ensureBrowser() {
  if (DEMO || await browser.isUp()) return;
  await browser.launch();
  await browser.attach().catch(() => {});
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const json = (res, code, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
};

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('Invalid JSON body'); }
}

async function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC) || !existsSync(file)) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end('Not found');
  }
  const body = await readFile(file);
  res.writeHead(200, {
    'content-type': MIME[extname(file)] || 'application/octet-stream',
    // The shell names the elements app.js wires up; a stale copy of it on a
    // phone would be a dead page, so it is never cached at all.
    'cache-control': extname(file) === '.html' ? 'no-store' : 'no-cache',
  });
  res.end(body);
}

/** Cards we have not swiped yet, topped up from the page when running low. */
async function topUpDeck({ force = false } = {}) {
  const seen = store.seenSlugs();
  if (DEMO) {
    buffer = DEMO_CARDS.filter((c) => !seen.has(c.slug));
    return buffer;
  }
  buffer = buffer.filter((c) => !seen.has(c.slug));
  if (!force && buffer.length >= 5) return buffer;

  const fresh = await linkedin.fetchCards({ rounds: force ? 4 : 3 });
  const have = new Set(buffer.map((c) => c.slug));
  for (const card of fresh) {
    if (!seen.has(card.slug) && !have.has(card.slug)) { buffer.push(card); have.add(card.slug); }
  }

  // Nothing new on the loaded page — reload it so LinkedIn hands us another batch.
  if (buffer.length === 0 && !force) {
    await linkedin.refreshFeed();
    return topUpDeck({ force: true });
  }
  return buffer;
}

async function handleApi(req, res, url) {
  const key = req.headers['x-swipe-key'] || url.searchParams.get('k');
  if (key !== KEY) return json(res, 401, { error: 'Bad or missing key. Open the URL printed by the server.' });

  const route = url.pathname;

  if (route === '/api/state') {
    const status = DEMO
      ? { loggedIn: true, demo: true, url: 'demo' }
      : await exclusive(() => linkedin.status()).catch((e) => ({ loggedIn: false, error: e.message }));
    return json(res, 200, {
      linkedIn: status,
      quota: store.quota(),
      stats: store.stats(),
      settings: store.settings,
      deckSize: buffer.length,
    });
  }

  // Sign in the way a person would: LinkedIn's own page, in the Chrome we drive.
  // The server only watches for the cookie that login leaves behind.
  if (route === '/api/login' && req.method === 'POST') {
    if (DEMO) return json(res, 200, { phase: 'done', loggedIn: true, demo: true });
    await ensureBrowser();
    const state = await exclusive(() => linkedin.startLogin());
    if (state.phase === 'done') buffer = [];
    return json(res, 200, state);
  }

  if (route === '/api/login/status') {
    if (DEMO) return json(res, 200, { phase: 'done', loggedIn: true, demo: true });
    const state = await exclusive(() => linkedin.loginStatus());
    if (state.phase === 'done') buffer = [];
    return json(res, 200, state);
  }

  if (route === '/api/session' && req.method === 'POST') {
    if (DEMO) return json(res, 200, { linkedIn: { loggedIn: true, demo: true }, note: 'Demo mode — the cookie was ignored.' });
    const body = await readBody(req);
    const status = await exclusive(() => linkedin.signInWithCookie(body.li_at || ''));
    buffer = [];
    return json(res, 200, { linkedIn: status });
  }

  if (route === '/api/deck') {
    const force = url.searchParams.get('refresh') === '1';
    if (force) { buffer = []; if (!DEMO) await exclusive(() => linkedin.refreshFeed()); }
    const cards = await exclusive(() => topUpDeck({ force }));
    return json(res, 200, { cards: cards.slice(0, 20), quota: store.quota() });
  }

  if (route === '/api/swipe' && req.method === 'POST') {
    const { slug, dir } = await readBody(req);
    const card = buffer.find((c) => c.slug === slug);
    if (!slug || !card) return json(res, 400, { error: 'Unknown card.' });

    if (dir === 'left') {
      store.record({ slug, name: card.name, url: card.url, dir: 'left', sent: false });
      buffer = buffer.filter((c) => c.slug !== slug);
      return json(res, 200, { ok: true, dir: 'left', quota: store.quota(), stats: store.stats() });
    }

    if (dir !== 'right') return json(res, 400, { error: 'dir must be "left" or "right".' });

    const blocked = store.blockReason();
    if (blocked) return json(res, 429, { ...blocked, quota: store.quota() });

    try {
      const result = DEMO ? { how: 'demo' } : await exclusive(() => linkedin.invite(slug));
      store.record({ slug, name: card.name, url: card.url, dir: 'right', sent: true, how: result.how });
      buffer = buffer.filter((c) => c.slug !== slug);
      return json(res, 200, { ok: true, dir: 'right', sent: true, quota: store.quota(), stats: store.stats() });
    } catch (err) {
      store.record({ slug, name: card.name, url: card.url, dir: 'right', sent: false, error: err.message });
      buffer = buffer.filter((c) => c.slug !== slug);
      return json(res, 200, {
        ok: false, dir: 'right', sent: false,
        error: err.message, code: err.code || 'INVITE_FAILED',
        quota: store.quota(), stats: store.stats(),
      });
    }
  }

  if (route === '/api/undo' && req.method === 'POST') {
    const removed = store.undoLastPass();
    if (!removed) return json(res, 200, { ok: false, error: 'Nothing to undo.' });
    buffer = [];
    return json(res, 200, { ok: true, restored: removed.name, stats: store.stats() });
  }

  if (route === '/api/settings' && req.method === 'POST') {
    const body = await readBody(req);
    return json(res, 200, { settings: store.updateSettings(body), quota: store.quota() });
  }

  if (route === '/api/history') {
    return json(res, 200, { swipes: store.recent(60), stats: store.stats() });
  }

  return json(res, 404, { error: 'No such endpoint.' });
}

// A request line is written by whoever made the request. Nothing from it
// reaches the log with a newline, an escape sequence, or any length it likes.
const forLog = (value) => String(value).replace(/[^\x20-\x7e]/g, '?').slice(0, 120);

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) {
    const started = Date.now();
    const line = `${forLog(req.method)} ${forLog(url.pathname)}`;
    res.on('finish', () => console.log(`  ${line} -> ${res.statusCode} (${Date.now() - started}ms)`));
    handleApi(req, res, url).catch((err) => {
      console.error(`  ${line} failed:`, err.message);
      if (!res.headersSent) json(res, 500, { error: err.message });
    });
  } else {
    serveStatic(res, url.pathname).catch(() => {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('Server error');
    });
  }
});

function lanAddress() {
  for (const list of Object.values(networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return '127.0.0.1';
}

const launched = DEMO ? { launched: false } : await browser.launch();
if (!DEMO) await browser.attach().catch(() => {});

server.listen(PORT, '0.0.0.0', () => {
  const link = `http://${lanAddress()}:${PORT}/?k=${KEY}`;
  console.log('\n  matched_in is running.\n');
  console.log(`  On your iPhone (same Wi-Fi):  ${link}`);
  console.log(`  On this Mac:                  http://localhost:${PORT}/?k=${KEY}`);
  if (DEMO) {
    console.log('\n  DEMO MODE — fixture profiles, no LinkedIn, nothing is sent.\n');
  } else {
    if (launched.skipped?.length) {
      console.log(`\n  Ports ${launched.skipped.join(', ')} belong to another browser — not touching it.`);
    }
    console.log(`\n  Chrome profile: ${join(DATA, 'chrome-profile')}${launched.launched ? ' (just launched)' : ' (already running)'} on port ${browser.port}`);
    console.log('  Not signed in to LinkedIn yet? Tap "Sign in to LinkedIn" in the app — it opens the login page here.\n');
  }
});

process.on('unhandledRejection', (err) => console.error('  unhandled rejection:', err?.message || err));
process.on('uncaughtException', (err) => console.error('  uncaught exception:', err?.message || err));

const shutdown = () => { browser.close(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1500); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
