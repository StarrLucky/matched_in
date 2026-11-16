// The whole app over real HTTP, in demo mode: no Chrome, no LinkedIn, nothing sent.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { startApp } from '../helpers/app.mjs';

let app;
before(async () => { app = await startApp({ demo: true }); });
after(async () => { await app?.stop(); });

test('serves the app shell', async () => {
  const res = await fetch(app.url('/'));
  const html = await res.text();
  assert.equal(res.status, 200);
  assert.match(html, /<title>matched_in<\/title>/);
  assert.match(html, /id="signIn"/, 'the sign-in button is in the markup');
});

test('the access key is required', async () => {
  const bare = await fetch(app.url('/api/state'));
  assert.equal(bare.status, 401);

  const wrong = await fetch(app.url('/api/state?k=not-the-key'));
  assert.equal(wrong.status, 401);
});

test('static files outside public/ are not served', async () => {
  const res = await fetch(app.url('/../package.json'));
  assert.equal(res.status, 404);
});

test('demo mode reports a usable session', async () => {
  const { status, body } = await app.api('/api/state');
  assert.equal(status, 200);
  assert.equal(body.linkedIn.loggedIn, true);
  assert.equal(body.linkedIn.demo, true);
  assert.deepEqual(body.stats, { total: 0, passed: 0, sent: 0, failed: 0 });
});

test('the deck comes back filled', async () => {
  const { body } = await app.api('/api/deck');
  assert.ok(body.cards.length >= 3);
  for (const card of body.cards) {
    assert.ok(card.slug, 'every card is addressable');
    assert.ok(card.name);
  }
});

test('a skip takes the card out of the deck, and undo brings it back', async () => {
  const first = (await app.api('/api/deck')).body.cards[0];

  const swipe = await app.api('/api/swipe', { method: 'POST', body: { slug: first.slug, dir: 'left' } });
  assert.equal(swipe.status, 200);
  assert.equal(swipe.body.stats.passed, 1);

  const after = (await app.api('/api/deck')).body.cards.map((c) => c.slug);
  assert.ok(!after.includes(first.slug), 'the skipped person is gone');

  const undo = await app.api('/api/undo', { method: 'POST' });
  assert.equal(undo.body.ok, true);
  assert.equal(undo.body.restored, first.name);

  const back = (await app.api('/api/deck')).body.cards.map((c) => c.slug);
  assert.ok(back.includes(first.slug), 'and is back after undo');
});

test('a connect swipe is recorded and counted', async () => {
  const card = (await app.api('/api/deck')).body.cards[0];
  const { body } = await app.api('/api/swipe', { method: 'POST', body: { slug: card.slug, dir: 'right' } });

  assert.equal(body.sent, true);
  assert.equal(body.quota.day, 1);
  assert.equal(body.stats.sent, 1);
});

test('the gap between invites is enforced', async () => {
  const card = (await app.api('/api/deck')).body.cards[0];
  const { status, body } = await app.api('/api/swipe', { method: 'POST', body: { slug: card.slug, dir: 'right' } });

  assert.equal(status, 429);
  assert.equal(body.code, 'TOO_FAST');
  assert.ok(body.message.length);

  const stillThere = (await app.api('/api/deck')).body.cards.map((c) => c.slug);
  assert.ok(stillThere.includes(card.slug), 'a throttled card stays in the deck');
});

test('settings are applied and clamped', async () => {
  const { body } = await app.api('/api/settings', {
    method: 'POST',
    body: { minGapSeconds: 0, maxPerDay: 9999, maxPerHour: 4 },
  });
  assert.equal(body.settings.minGapSeconds, 0);
  assert.equal(body.settings.maxPerDay, 150, 'clamped to the ceiling');
  assert.equal(body.settings.maxPerHour, 4);

  const card = (await app.api('/api/deck')).body.cards[0];
  const swipe = await app.api('/api/swipe', { method: 'POST', body: { slug: card.slug, dir: 'right' } });
  assert.equal(swipe.status, 200, 'with no gap to wait out, the next invite goes through');
});

test('the hourly ceiling stops the deck', async () => {
  await app.api('/api/settings', { method: 'POST', body: { maxPerHour: 2, minGapSeconds: 0 } });
  const card = (await app.api('/api/deck')).body.cards[0];

  const { status, body } = await app.api('/api/swipe', { method: 'POST', body: { slug: card.slug, dir: 'right' } });
  assert.equal(status, 429);
  assert.equal(body.code, 'HOUR_LIMIT');

  await app.api('/api/settings', { method: 'POST', body: { maxPerHour: 12 } });
});

test('an unknown card is refused', async () => {
  const { status, body } = await app.api('/api/swipe', { method: 'POST', body: { slug: 'nobody-here', dir: 'right' } });
  assert.equal(status, 400);
  assert.match(body.error, /unknown card/i);
});

test('a bad direction is refused', async () => {
  const card = (await app.api('/api/deck')).body.cards[0];
  const { status } = await app.api('/api/swipe', { method: 'POST', body: { slug: card.slug, dir: 'sideways' } });
  assert.equal(status, 400);
});

test('sign-in is a no-op in demo mode', async () => {
  const start = await app.api('/api/login', { method: 'POST' });
  assert.equal(start.body.phase, 'done');

  const status = await app.api('/api/login/status');
  assert.equal(status.body.loggedIn, true);
});

test('history holds every swipe, newest first', async () => {
  const { body } = await app.api('/api/history');

  // Two invites went out; the skip was undone and the refusals were never recorded.
  assert.equal(body.swipes.length, 2);
  assert.ok(body.swipes.every((s) => s.dir === 'right' && s.sent));
  assert.ok(body.swipes[0].at >= body.swipes[1].at, 'newest first');
  assert.equal(body.stats.total, body.swipes.length);
});

test('unknown endpoints say so', async () => {
  const { status } = await app.api('/api/nope');
  assert.equal(status, 404);
});
