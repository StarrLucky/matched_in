// The driver's decisions, with the page faked out.
//
// Answers are queues: each entry is used once, the last one repeats. An answer
// that is itself an array goes in as a one-element queue, e.g. [[card, card]].
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LinkedIn, FEED_URL, LOGIN_URL } from '../../server/linkedin.mjs';
import { FakeBrowser } from '../helpers/fake-browser.mjs';

// Deliberately unlike a real li_at value: the security gate scans this repo for
// anything shaped like a session cookie.
const COOKIE = 'not-a-real-session-value-0123456789wxyz';

// Short fuses so the polling loops finish inside a test run.
const driver = (browser, opts = {}) => new LinkedIn(browser, { inviteTimeout: 1500, retryAfter: 400, ...opts });

test('invite returns once the button says it went out', async () => {
  const page = new FakeBrowser({
    rect: [{ ok: true, x: 10, y: 20 }],
    modal: [{ present: false }],
    confirm: [{ sent: false, how: 'button-still-there' }, { sent: true, how: 'button-changed' }],
  });

  const result = await driver(page, { retryAfter: 60_000 }).invite('ada');

  assert.equal(result.sent, true);
  assert.deepEqual(page.clicks, [[10, 20]], 'the Connect button is clicked exactly once');
  assert.equal(page.awake, 1, 'the tab is woken before clicking');
});

test('invite answers the note dialog by sending without a note', async () => {
  const page = new FakeBrowser({
    rect: [{ ok: true, x: 10, y: 20 }],
    modal: [{ present: true, actionable: true, x: 55, y: 66 }, { present: false }],
    confirm: [{ sent: false, how: 'button-still-there' }, { sent: true, how: 'button-changed' }],
  });

  const result = await driver(page, { retryAfter: 60_000 }).invite('ada');

  assert.equal(result.sent, true);
  assert.deepEqual(page.clicks, [[10, 20], [55, 66]], 'button, then "send without a note"');
});

test('invite refuses a dialog that wants a note or an email', async () => {
  const page = new FakeBrowser({
    rect: [{ ok: true, x: 10, y: 20 }],
    modal: [{ present: true, actionable: false }],
    confirm: [{ sent: false, how: 'button-still-there' }],
  });

  await assert.rejects(driver(page).invite('ada'), (err) => {
    assert.equal(err.code, 'MODAL_BLOCKED');
    return true;
  });
  assert.deepEqual(page.clicks, [[10, 20]], 'nothing inside the dialog is clicked');
});

test('a swallowed click is tried once more, then reported honestly', async () => {
  const page = new FakeBrowser({
    rect: [{ ok: true, x: 10, y: 20 }],
    modal: [{ present: false }],
    confirm: [{ sent: false, how: 'button-still-there' }],
    retryRect: [{ ok: true, x: 11, y: 21 }],
  });

  await assert.rejects(driver(page).invite('ada'), (err) => {
    assert.equal(err.code, 'NOT_CONFIRMED');
    return true;
  });
  assert.deepEqual(page.clicks, [[10, 20], [11, 21]]);
  assert.equal(page.countOf('retryRect'), 1, 'it retries at most once');
});

test('the retry never clicks a button that has changed under it', async () => {
  // This is the one that would withdraw an invitation we had just sent.
  const page = new FakeBrowser({
    rect: [{ ok: true, x: 10, y: 20 }],
    modal: [{ present: false }],
    confirm: [{ sent: false, how: 'button-still-there' }],
    retryRect: [{ ok: false, reason: 'changed' }],
  });

  await assert.rejects(driver(page).invite('ada'), (err) => err.code === 'NOT_CONFIRMED');
  assert.deepEqual(page.clicks, [[10, 20]], 'only the original click happened');
});

test('a missing card is reloaded once before giving up', async () => {
  const page = new FakeBrowser({
    rect: [{ ok: false, reason: 'card-gone' }],
    scroll: [1200],
  });

  await assert.rejects(driver(page).invite('ada'), (err) => {
    assert.equal(err.code, 'NO_BUTTON');
    return true;
  });
  assert.deepEqual(page.navigations, [FEED_URL]);
  assert.deepEqual(page.clicks, [], 'nothing is clicked when the button cannot be found');
});

test('status trusts the cookie and reloads a stale page once', async () => {
  const page = new FakeBrowser({
    loggedIn: [
      { loggedIn: false, reason: 'auth-page', url: 'https://www.linkedin.com/login' },
      { loggedIn: true, url: FEED_URL, signals: {} },
    ],
  });
  page.cookies.li_at = COOKIE;

  const state = await driver(page).status();

  assert.equal(state.loggedIn, true);
  assert.equal(state.cookie, true);
  assert.equal(state.cookiePreview, 'not-…wxyz', 'the preview shows the ends only');
  assert.deepEqual(page.navigations, [FEED_URL]);
});

test('status reports a signed-out profile as signed out', async () => {
  const page = new FakeBrowser({
    loggedIn: [{ loggedIn: false, reason: 'auth-page', url: 'https://www.linkedin.com/login' }],
  });

  const state = await driver(page).status();

  assert.equal(state.loggedIn, false);
  assert.equal(state.cookie, false);
  assert.equal(state.cookiePreview, null);
  assert.equal(page.countOf('loggedIn'), 1, 'no pointless reload without a cookie');
});

test('a pasted cookie is cleaned up, and rubbish is refused', async () => {
  const page = new FakeBrowser({ loggedIn: [{ loggedIn: true, url: FEED_URL }] });
  const linkedin = driver(page);

  await assert.rejects(linkedin.signInWithCookie('too-short'), /does not look like an li_at/);
  await assert.rejects(linkedin.signInWithCookie(''), /does not look like an li_at/);

  await linkedin.signInWithCookie(`  li_at="${COOKIE}";  `);
  assert.equal(page.cookies.li_at, COOKIE, 'the name, quotes and semicolon are stripped');
});

test('startLogin opens the login page and raises the window', async () => {
  const page = new FakeBrowser({ loggedIn: [{ loggedIn: false, reason: 'auth-page' }] });
  page.url = 'https://www.linkedin.com/login';

  const state = await driver(page).startLogin();

  assert.equal(state.phase, 'waiting');
  assert.equal(state.loggedIn, false);
  assert.ok(page.navigations.includes(LOGIN_URL));
  assert.equal(page.fronted, 1);
  assert.equal(page.reattached, 1, 'it re-binds in case the tab was replaced');
});

test('startLogin skips the login page when the session is already there', async () => {
  const page = new FakeBrowser({ loggedIn: [{ loggedIn: true, url: FEED_URL }] });
  page.cookies.li_at = COOKIE;

  const state = await driver(page).startLogin();

  assert.equal(state.phase, 'done');
  assert.ok(!page.navigations.includes(LOGIN_URL), 'no detour through the login page');
});

test('loginStatus names the two-factor step', async () => {
  const page = new FakeBrowser({ loggedIn: [{ loggedIn: false, reason: 'auth-page' }] });
  page.url = 'https://www.linkedin.com/checkpoint/challenge/verify';

  assert.equal((await driver(page).loginStatus()).phase, 'checkpoint');
});

test('loginStatus parks the tab on the suggestions once signed in', async () => {
  const page = new FakeBrowser({ loggedIn: [{ loggedIn: true, url: FEED_URL }] });
  page.cookies.li_at = COOKIE;
  page.url = 'https://www.linkedin.com/feed/';

  const state = await driver(page).loginStatus();

  assert.equal(state.phase, 'done');
  assert.equal(state.cookiePreview, 'not-…wxyz');
  assert.deepEqual(page.navigations, [FEED_URL]);
});

test('fetchCards keeps only profiles it can address', async () => {
  const page = new FakeBrowser({
    loggedIn: [{ loggedIn: true, url: FEED_URL }],
    scroll: [900],
    extract: [[
      { name: 'Ada', url: 'https://www.linkedin.com/in/Ada-Lovelace/' },
      { name: 'Nobody', url: 'https://www.linkedin.com/company/acme/' },
    ]],
  });
  page.url = FEED_URL;

  const cards = await driver(page).fetchCards({ rounds: 1 });

  assert.equal(cards.length, 1);
  assert.equal(cards[0].slug, 'ada-lovelace', 'the slug is lowercased for matching');
});

test('fetchCards refuses to scrape a signed-out page', async () => {
  const page = new FakeBrowser({ loggedIn: [{ loggedIn: false, reason: 'auth-page' }] });
  page.url = FEED_URL;

  await assert.rejects(driver(page).fetchCards(), (err) => {
    assert.equal(err.code, 'NO_SESSION');
    return true;
  });
});
