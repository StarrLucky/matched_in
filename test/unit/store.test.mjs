import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store } from '../../server/store.mjs';

const freshStore = () => {
  const dir = mkdtempSync(join(tmpdir(), 'matched-in-store-'));
  const store = new Store(join(dir, 'state.json'));
  store.dispose = () => rmSync(dir, { recursive: true, force: true });
  return store;
};

const sentAt = (store, slug, at) => store.record({ slug, name: slug, dir: 'right', sent: true, at });

test('starts on the cautious defaults', () => {
  const store = freshStore();
  assert.deepEqual(store.settings, { maxPerHour: 12, maxPerDay: 35, minGapSeconds: 6 });
  store.dispose();
});

test('settings are clamped, and nonsense is ignored', () => {
  const store = freshStore();
  assert.equal(store.updateSettings({ maxPerDay: 9999 }).maxPerDay, 150);
  assert.equal(store.updateSettings({ maxPerHour: 9999 }).maxPerHour, 100);
  assert.equal(store.updateSettings({ minGapSeconds: -5 }).minGapSeconds, 6, 'negative gap rejected');
  assert.equal(store.updateSettings({ maxPerHour: 'soon' }).maxPerHour, 100, 'non-numeric rejected');
  assert.equal(store.updateSettings({ minGapSeconds: 0 }).minGapSeconds, 0, 'zero is allowed');
  store.dispose();
});

test('a cleared limit field leaves the limit alone', () => {
  const store = freshStore();
  store.updateSettings({ maxPerHour: 8, maxPerDay: 20, minGapSeconds: 4 });

  // What the app sends when a thumb empties the field: '' — not zero.
  const after = store.updateSettings({ maxPerHour: '', maxPerDay: '', minGapSeconds: '' });
  assert.deepEqual(after, { maxPerHour: 8, maxPerDay: 20, minGapSeconds: 4 });

  // Zero invites per hour is not a setting, it is a broken app.
  assert.equal(store.updateSettings({ maxPerHour: 0 }).maxPerHour, 8);
  assert.equal(store.updateSettings({ maxPerDay: 0 }).maxPerDay, 20);
  assert.equal(store.blockReason(), null, 'and nothing is blocked by a phantom ceiling');
  store.dispose();
});

test('settings and history survive a restart', () => {
  const store = freshStore();
  store.updateSettings({ maxPerDay: 20 });
  store.record({ slug: 'ada', name: 'Ada', dir: 'left', sent: false });

  const reopened = new Store(store.file);
  assert.equal(reopened.settings.maxPerDay, 20);
  assert.deepEqual([...reopened.seenSlugs()], ['ada']);
  store.dispose();
});

test('a corrupt state file does not stop the app', () => {
  const store = freshStore();
  writeFileSync(store.file, '{ this is not json');
  const reopened = new Store(store.file);
  assert.deepEqual(reopened.settings, { maxPerHour: 12, maxPerDay: 35, minGapSeconds: 6 });
  assert.deepEqual(reopened.stats(), { total: 0, passed: 0, sent: 0, failed: 0 });
  store.dispose();
});

test('everyone swiped is remembered, so nobody comes back', () => {
  const store = freshStore();
  store.record({ slug: 'ada', dir: 'left', sent: false });
  store.record({ slug: 'grace', dir: 'right', sent: true });
  store.record({ slug: 'linus', dir: 'right', sent: false, error: 'nope' });
  assert.deepEqual([...store.seenSlugs()].sort(), ['ada', 'grace', 'linus']);
  assert.deepEqual(store.stats(), { total: 3, passed: 1, sent: 1, failed: 1 });
  store.dispose();
});

test('undo takes back the last skip and never an invite', () => {
  const store = freshStore();
  store.record({ slug: 'ada', name: 'Ada', dir: 'left', sent: false });
  store.record({ slug: 'grace', name: 'Grace', dir: 'right', sent: true });
  store.record({ slug: 'linus', name: 'Linus', dir: 'left', sent: false });

  assert.equal(store.undoLastPass().name, 'Linus');
  assert.equal(store.undoLastPass().name, 'Ada');
  assert.equal(store.undoLastPass(), null, 'the sent invite is not undoable');
  assert.deepEqual([...store.seenSlugs()], ['grace']);
  store.dispose();
});

test('quota counts sent invites inside each window only', () => {
  const store = freshStore();
  const now = Date.now();
  sentAt(store, 'two-days-ago', now - 2 * 86_400_000);
  sentAt(store, 'this-morning', now - 5 * 3_600_000);
  sentAt(store, 'just-now', now - 1000);
  store.record({ slug: 'failed', dir: 'right', sent: false, at: now - 2000 });
  store.record({ slug: 'skipped', dir: 'left', sent: false, at: now - 3000 });

  const q = store.quota();
  assert.equal(q.hour, 1, 'only the recent one is within the hour');
  assert.equal(q.day, 2, 'the two-day-old one has aged out');
  assert.equal(q.hourLeft, 11);
  assert.equal(q.dayLeft, 33);
  store.dispose();
});

test('blockReason reports the daily ceiling first', () => {
  const store = freshStore();
  store.updateSettings({ maxPerDay: 2, maxPerHour: 2, minGapSeconds: 0 });
  const now = Date.now();
  sentAt(store, 'a', now - 7_200_000);
  sentAt(store, 'b', now - 7_200_000);
  assert.equal(store.blockReason().code, 'DAY_LIMIT');
  store.dispose();
});

test('blockReason reports the hourly ceiling', () => {
  const store = freshStore();
  store.updateSettings({ maxPerDay: 50, maxPerHour: 1, minGapSeconds: 0 });
  sentAt(store, 'a', Date.now() - 60_000);
  assert.equal(store.blockReason().code, 'HOUR_LIMIT');
  store.dispose();
});

test('blockReason keeps the gap between invites', () => {
  const store = freshStore();
  store.updateSettings({ minGapSeconds: 30 });
  store.record({ slug: 'a', dir: 'right', sent: true });

  const blocked = store.blockReason();
  assert.equal(blocked.code, 'TOO_FAST');
  assert.ok(blocked.waitSeconds > 0 && blocked.waitSeconds <= 30);

  store.updateSettings({ minGapSeconds: 0 });
  assert.equal(store.blockReason(), null);
  store.dispose();
});

test('a failed invite does not count against the quota', () => {
  const store = freshStore();
  store.updateSettings({ minGapSeconds: 0 });
  store.record({ slug: 'a', dir: 'right', sent: false, error: 'Click did not register as an invite.' });
  assert.equal(store.quota().day, 0);
  assert.equal(store.blockReason(), null);
  store.dispose();
});

test('recent() is newest first and capped', () => {
  const store = freshStore();
  for (let i = 0; i < 10; i++) store.record({ slug: `p${i}`, dir: 'left', sent: false });
  const recent = store.recent(3);
  assert.deepEqual(recent.map((s) => s.slug), ['p9', 'p8', 'p7']);
  store.dispose();
});
