// The front end in a real browser: a real drag on a real card, against the
// real server in demo mode. Headless Chrome, its own throwaway profile.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Browser, findChrome } from '../../server/chrome.mjs';
import { startApp, freePort } from '../helpers/app.mjs';

const noChrome = findChrome() ? false : 'Chrome is not installed on this machine';

let app;
let browser;
let profileDir;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll the page until the snippet returns something truthy, or give up. */
async function waitFor(expression, { timeoutMs = 10_000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await browser.evaluate(expression);
    if (last) return last;
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${label} (last value: ${JSON.stringify(last)})`);
}

before(async () => {
  if (noChrome) return;
  app = await startApp({ demo: true });
  profileDir = mkdtempSync(join(tmpdir(), 'matched-in-ui-'));
  browser = new Browser({
    port: await freePort(),
    userDataDir: join(profileDir, 'profile'),
    startUrl: app.url(`/?k=${app.key}`),
    args: ['--headless=new', '--window-size=430,932', '--hide-scrollbars'],
    match: '127.0.0.1',
  });
  await browser.launch();
  await browser.attach();
});

after(async () => {
  browser?.close();
  if (browser?.proc?.pid) {
    try { process.kill(browser.proc.pid, 'SIGTERM'); } catch { /* already gone */ }
  }
  await sleep(300);
  if (profileDir) rmSync(profileDir, { recursive: true, force: true });
  await app?.stop();
});

test('the deck renders cards from the server', { skip: noChrome }, async () => {
  const card = await waitFor(`
    const el = document.querySelector('.card[data-depth="0"]');
    if (!el) return null;
    return { slug: el.dataset.slug, name: el.querySelector('.nm')?.textContent || '' };
  `, { label: 'the first card' });

  assert.ok(card.slug, 'the top card knows who it is');
  assert.ok(card.name.length, 'and shows a name');

  const title = await browser.evaluate('return document.title;');
  assert.equal(title, 'matched_in');
});

test('dragging a card to the left skips that person', { skip: noChrome }, async () => {
  const card = await waitFor(`
    const el = document.querySelector('.card[data-depth="0"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { slug: el.dataset.slug, x: r.x + r.width / 2, y: r.y + r.height / 2 };
  `, { label: 'a card to drag' });

  // A real pointer drag: press, several moves, release — the gesture the
  // phone makes, with the button held down the whole way.
  const page = await browser.attach();
  const move = (x, y, buttons = 0) => page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(x), y: Math.round(y), button: buttons ? 'left' : 'none', buttons });

  await move(card.x, card.y);
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(card.x), y: Math.round(card.y), button: 'left', buttons: 1, clickCount: 1 });
  for (let step = 1; step <= 8; step++) {
    await move(card.x - step * 28, card.y, 1);
    await sleep(25);
  }
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(card.x - 224), y: Math.round(card.y), button: 'left', buttons: 0, clickCount: 1 });

  await waitFor(`return !document.querySelector('.card[data-slug=${JSON.stringify(card.slug)}]');`,
    { label: 'the card to leave the deck' });

  const { body } = await app.api('/api/history');
  const entry = body.swipes.find((s) => s.slug === card.slug);
  assert.ok(entry, 'the server heard about the swipe');
  assert.equal(entry.dir, 'left');
  assert.equal(entry.sent, false, 'a skip sends nothing');
  assert.equal(body.stats.sent, 0);
});

test('the settings sheet offers the LinkedIn sign-in', { skip: noChrome }, async () => {
  const gear = await waitFor(`
    const el = document.getElementById('openSettings');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  `, { label: 'the settings button' });

  await browser.clickAt(gear.x, gear.y);

  const sheet = await waitFor(`
    const el = document.getElementById('sheet');
    if (!el || el.classList.contains('hidden')) return null;
    return {
      signIn: document.getElementById('signIn')?.textContent || '',
      session: document.getElementById('sessionState')?.textContent || '',
      hasCookieFallback: !!document.getElementById('liAt'),
    };
  `, { label: 'the settings sheet' });

  assert.match(sheet.signIn, /sign in/i);
  assert.ok(sheet.hasCookieFallback, 'pasting a cookie is still available');
  assert.ok(sheet.session.length, 'the session line says something');
});

test('without a key the app asks for one instead of dead-ending', { skip: noChrome }, async () => {
  // What an iPhone sees after "Add to Home Screen": the launch URL carries no
  // ?k=, and the standalone app has its own storage, so the key is simply gone.
  await browser.evaluate(`localStorage.clear(); return 1;`);
  await browser.navigate(app.url('/'), { waitMs: 1200 });

  const prompt = await waitFor(`
    const form = document.getElementById('keyForm');
    if (!form || form.classList.contains('hidden')) return null;
    return { title: document.getElementById('emptyTitle').textContent };
  `, { label: 'the access key form' });
  assert.match(prompt.title, /access key/i);

  // Pasting the whole link works, not just the bare key.
  await browser.evaluate(`
    document.getElementById('keyInput').value = ${JSON.stringify(app.url(`/?k=${app.key}`))};
    document.getElementById('keyForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    return 1;
  `);

  const slug = await waitFor(`
    const el = document.querySelector('.card[data-depth="0"]');
    return el ? el.dataset.slug : null;
  `, { label: 'the deck after the key was entered' });
  assert.ok(slug, 'the deck loads once the key is in');

  const stored = await browser.evaluate(`return localStorage.getItem('matchedin.key');`);
  assert.equal(stored, app.key, 'and only the key itself is kept');
});

test('a bad key never leaves the sign-in sheet stuck', { skip: noChrome }, async () => {
  // What the phone hit: no key, so tapping Sign in printed the server's
  // "Bad or missing key" into the sheet and left it there for good.
  await browser.evaluate(`localStorage.setItem('matchedin.key', 'not-the-key'); return 1;`);
  await browser.navigate(app.url('/'), { waitMs: 1200 });

  await browser.evaluate(`
    document.getElementById('openSettings').click();
    document.getElementById('signIn').click();
    return 1;
  `);

  const state = await waitFor(`
    const login = document.getElementById('login');
    const form = document.getElementById('keyForm');
    if (!login.classList.contains('hidden') || form.classList.contains('hidden')) return null;
    return {
      settingsHidden: document.getElementById('sheet').classList.contains('hidden'),
      title: document.getElementById('emptyTitle').textContent,
    };
  `, { label: 'the sheets to give way to the key form' });

  assert.equal(state.settingsHidden, true, 'settings closes too');
  assert.match(state.title, /access key/i);

  // And the way back in is right there.
  await browser.evaluate(`
    document.getElementById('keyInput').value = ${JSON.stringify(app.key)};
    document.getElementById('keyForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    return 1;
  `);
  await waitFor(`return !!document.querySelector('.card[data-depth="0"]');`, { label: 'the deck to come back' });
});

test('a quick twitch to the right does not send anything', { skip: noChrome }, async () => {
  // 25px, fast: the old rule read that as a flick and sent an invitation.
  await browser.navigate(app.url(`/?k=${app.key}`), { waitMs: 1500 });

  const slug = await waitFor(`
    const el = document.querySelector('.card[data-depth="0"]');
    return el ? el.dataset.slug : null;
  `, { label: 'a card to twitch' });

  const sentBefore = (await app.api('/api/history')).body.stats.sent;

  await browser.evaluate(`
    const el = document.querySelector('.card[data-depth="0"]');
    const r = el.getBoundingClientRect();
    const x = r.x + r.width / 2, y = r.y + r.height / 2;
    const fire = (type, cx) => el.dispatchEvent(new PointerEvent(type, {
      pointerId: 1, pointerType: 'touch', isPrimary: true, clientX: cx, clientY: y, bubbles: true, cancelable: true,
    }));
    fire('pointerdown', x);
    for (let i = 1; i <= 5; i++) { await new Promise(r => setTimeout(r, 8)); fire('pointermove', x + i * 5); }
    fire('pointerup', x + 25);
    await new Promise(r => setTimeout(r, 900));
    return 1;
  `);

  const stillThere = await browser.evaluate(`return !!document.querySelector('.card[data-slug=${JSON.stringify(slug)}]');`);
  assert.equal(stillThere, true, 'the card stays put');
  assert.equal((await app.api('/api/history')).body.stats.sent, sentBefore, 'and nothing was sent');
});
