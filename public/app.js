'use strict';

/* ---------- api ---------- */

const KEY_STORE = 'inswipe.key';
const params = new URLSearchParams(location.search);
if (params.get('k')) {
  localStorage.setItem(KEY_STORE, params.get('k'));
  history.replaceState(null, '', location.pathname);
}
const KEY = localStorage.getItem(KEY_STORE) || '';

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: { 'x-swipe-key': KEY, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch { /* non-JSON error page */ }
  if (!res.ok && res.status !== 429) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status, data });
  return { status: res.status, ...data };
}

/** fetch() rejects with a bare "Failed to fetch" / "Load failed" when the server is gone. */
function friendly(err) {
  if (err instanceof TypeError || /failed to fetch|load failed|networkerror/i.test(err.message)) {
    return 'Server not responding — is `npm start` still running on your Mac, and are you on the same Wi-Fi?';
  }
  return err.message;
}

/* ---------- elements ---------- */

const $ = (id) => document.getElementById(id);
const deck = $('deck');
const empty = $('empty');
const emptyTitle = $('emptyTitle');
const emptyBody = $('emptyBody');
const emptyAction = $('emptyAction');
const quotaEl = $('quota');
const toastEl = $('toast');
const sheet = $('sheet');

/* ---------- state ---------- */

let cards = [];
let busy = false;
let lastQuota = null;

const SWIPE_DISTANCE = 110;
const SWIPE_VELOCITY = 0.45;

/* ---------- helpers ---------- */

let toastTimer;
function toast(message, kind = '') {
  clearTimeout(toastTimer);
  toastEl.textContent = message;
  toastEl.className = `toast show ${kind}`;
  toastTimer = setTimeout(() => { toastEl.className = 'toast'; }, 3400);
}

function paintQuota(q) {
  if (!q) return;
  lastQuota = q;
  quotaEl.textContent = `${q.day}/${q.maxPerDay} today`;
  quotaEl.className = 'quota' + (q.dayLeft === 0 || q.hourLeft === 0 ? ' stop' : q.dayLeft <= 5 ? ' warn' : '');
}

function showEmpty(title, body = '', action = null) {
  emptyTitle.textContent = title;
  emptyBody.textContent = body;
  empty.classList.remove('hidden');
  emptyAction.classList.toggle('hidden', !action);
  if (action) {
    emptyAction.textContent = action.label;
    emptyAction.onclick = action.run;
  }
}

/* ---------- rendering ---------- */

function buildCard(card, depth) {
  const el = document.createElement('article');
  el.className = 'card';
  el.dataset.depth = String(depth);
  el.dataset.slug = card.slug;

  const initial = (card.name || '?').trim().charAt(0).toUpperCase();
  // LinkedIn avatars top out at 400px, so blowing one up full-bleed looks mushy.
  // A blurred copy fills the card and the crisp original sits on top.
  const backdrop = card.banner || card.photo;
  el.innerHTML = `
    ${backdrop ? `<div class="card-backdrop" style="background-image:url(${JSON.stringify(backdrop)})"></div>` : ''}
    <div class="card-portrait">
      ${card.photo
        ? `<img class="card-avatar" src=${JSON.stringify(card.photo)} alt="" referrerpolicy="no-referrer" loading="eager">`
        : `<div class="card-avatar card-initial">${initial}</div>`}
    </div>
    <div class="card-shade"></div>
    <div class="stamp stamp-yes">CONNECT</div>
    <div class="stamp stamp-no">SKIP</div>
    <div class="card-body">
      <h2 class="card-name"><span class="nm"></span>${card.degree ? `<span class="card-degree">${card.degree}</span>` : ''}</h2>
      ${card.headline ? '<p class="card-headline"></p>' : ''}
      ${card.mutuals ? '<p class="card-mutuals"></p>' : ''}
    </div>`;

  // Text goes in as text, never as markup — these strings come off a web page.
  el.querySelector('.nm').textContent = card.name || 'Unknown';
  if (card.headline) el.querySelector('.card-headline').textContent = card.headline;
  if (card.mutuals) el.querySelector('.card-mutuals').textContent = card.mutuals;

  if (depth === 0) attachDrag(el);
  return el;
}

function render() {
  deck.querySelectorAll('.card').forEach((el) => el.remove());
  if (!cards.length) return;

  empty.classList.add('hidden');
  // Later in the DOM paints on top, so build back-to-front.
  const visible = cards.slice(0, 3);
  for (let i = visible.length - 1; i >= 0; i--) deck.appendChild(buildCard(visible[i], i));
}

/* ---------- gestures ---------- */

function attachDrag(el) {
  const yes = el.querySelector('.stamp-yes');
  const no = el.querySelector('.stamp-no');
  let startX = 0, startY = 0, startT = 0, dx = 0, dy = 0, dragging = false, pid = null;

  const paint = () => {
    const rot = dx / 18;
    el.style.transform = `translate(${dx}px, ${dy}px) rotate(${rot}deg)`;
    const strength = Math.min(1, Math.abs(dx) / SWIPE_DISTANCE);
    yes.style.opacity = dx > 0 ? strength : 0;
    no.style.opacity = dx < 0 ? strength : 0;
  };

  el.addEventListener('pointerdown', (e) => {
    if (busy) return;
    dragging = true; pid = e.pointerId;
    startX = e.clientX; startY = e.clientY; startT = performance.now();
    dx = dy = 0;
    el.classList.remove('settling');
    el.setPointerCapture(pid);
  });

  el.addEventListener('pointermove', (e) => {
    if (!dragging || e.pointerId !== pid) return;
    dx = e.clientX - startX;
    dy = (e.clientY - startY) * 0.4;
    paint();
  });

  const finish = (e) => {
    if (!dragging || e.pointerId !== pid) return;
    dragging = false;
    try { el.releasePointerCapture(pid); } catch { /* pointer already gone */ }

    const velocity = Math.abs(dx) / Math.max(1, performance.now() - startT);
    const decided = Math.abs(dx) > SWIPE_DISTANCE || velocity > SWIPE_VELOCITY;

    if (decided) {
      flyOut(el, dx > 0 ? 'right' : 'left');
    } else {
      el.classList.add('settling');
      el.style.transform = '';
      yes.style.opacity = no.style.opacity = 0;
    }
  };

  el.addEventListener('pointerup', finish);
  el.addEventListener('pointercancel', finish);
}

function flyOut(el, dir) {
  if (busy) return;
  busy = true;
  const slug = el.dataset.slug;
  const offset = (dir === 'right' ? 1 : -1) * (window.innerWidth + 260);
  el.classList.add('flying');
  el.style.transform = `translate(${offset}px, -40px) rotate(${dir === 'right' ? 26 : -26}deg)`;
  el.style.opacity = '0';
  el.querySelector(dir === 'right' ? '.stamp-yes' : '.stamp-no').style.opacity = '1';

  const card = cards.find((c) => c.slug === slug);
  cards = cards.filter((c) => c.slug !== slug);

  setTimeout(() => { render(); commit(card, dir); }, 300);
}

function swipeTop(dir) {
  const top = deck.querySelector('.card[data-depth="0"]');
  if (top && !busy) flyOut(top, dir);
}

/* ---------- actions ---------- */

async function commit(card, dir) {
  if (!card) { busy = false; return; }
  try {
    const res = await api('/api/swipe', { method: 'POST', body: { slug: card.slug, dir } });

    if (res.status === 429) {
      cards.unshift(card);          // nothing was sent — put the person back
      render();
      toast(res.message || 'Rate limit reached.', 'bad');
    } else if (dir === 'right' && res.sent) {
      toast(`Invite sent to ${card.name}`, 'good');
    } else if (dir === 'right') {
      toast(`Could not invite ${card.name}: ${res.error || 'unknown error'}`, 'bad');
    }
    paintQuota(res.quota);
  } catch (err) {
    cards.unshift(card);
    render();
    toast(friendly(err), 'bad');
  } finally {
    busy = false;
    if (cards.length <= 3) loadDeck({ quiet: true });
    if (!cards.length) showEmpty('No more suggestions', 'LinkedIn has run out for now.', { label: 'Reload', run: () => loadDeck({ refresh: true }) });
  }
}

async function loadDeck({ refresh = false, quiet = false } = {}) {
  if (!quiet) showEmpty('Loading suggestions…');
  try {
    const res = await api(`/api/deck${refresh ? '?refresh=1' : ''}`);
    const known = new Set(cards.map((c) => c.slug));
    for (const card of res.cards || []) if (!known.has(card.slug)) cards.push(card);
    paintQuota(res.quota);

    if (!cards.length) {
      showEmpty('No suggestions right now', 'LinkedIn had nothing new on the page.', { label: 'Try again', run: () => loadDeck({ refresh: true }) });
    } else {
      render();
    }
  } catch (err) {
    if (err.status === 401) {
      showEmpty('Wrong access key', 'Open the link the server printed in the terminal.');
    } else if (/not signed in/i.test(err.message)) {
      showEmpty('LinkedIn is not signed in', 'Paste your li_at cookie in Settings, or sign in in the Chrome window on your Mac.', { label: 'Open settings', run: openSheet });
    } else {
      showEmpty('Could not load suggestions', friendly(err), { label: 'Retry', run: () => loadDeck({ refresh: true }) });
    }
  }
}

/* ---------- settings ---------- */

async function refreshState() {
  try {
    const s = await api('/api/state');
    paintQuota(s.quota);
    $('sessionState').textContent = s.linkedIn?.loggedIn
      ? 'Signed in and ready.'
      : 'Not signed in to LinkedIn.';
    $('maxPerHour').value = s.settings.maxPerHour;
    $('maxPerDay').value = s.settings.maxPerDay;
    $('minGapSeconds').value = s.settings.minGapSeconds;
    $('statsLine').textContent = `${s.stats.sent} sent · ${s.stats.passed} skipped · ${s.stats.failed} failed`;
  } catch (err) {
    $('sessionState').textContent = friendly(err);
  }
}

function openSheet() { sheet.classList.remove('hidden'); refreshState(); }
function closeSheet() { sheet.classList.add('hidden'); }

/* ---------- wiring ---------- */

$('btnPass').onclick = () => swipeTop('left');
$('btnConnect').onclick = () => swipeTop('right');
$('btnUndo').onclick = async () => {
  try {
    const res = await api('/api/undo', { method: 'POST' });
    if (!res.ok) return toast(res.error || 'Nothing to undo.');
    toast(`${res.restored} is back in the deck`);
    cards = [];
    await loadDeck();
  } catch (err) { toast(friendly(err), 'bad'); }
};

$('openSettings').onclick = openSheet;
$('closeSettings').onclick = closeSheet;
sheet.addEventListener('click', (e) => { if (e.target === sheet) closeSheet(); });

$('saveSession').onclick = async () => {
  const value = $('liAt').value.trim();
  if (!value) return toast('Paste the cookie value first.');
  $('sessionState').textContent = 'Signing in…';
  try {
    const res = await api('/api/session', { method: 'POST', body: { li_at: value } });
    $('liAt').value = '';
    $('sessionState').textContent = res.linkedIn?.loggedIn ? 'Signed in and ready.' : 'LinkedIn did not accept that cookie.';
    if (res.linkedIn?.loggedIn) { closeSheet(); cards = []; loadDeck({ refresh: true }); }
  } catch (err) { $('sessionState').textContent = friendly(err); }
};

$('saveLimits').onclick = async () => {
  try {
    const res = await api('/api/settings', {
      method: 'POST',
      body: {
        maxPerHour: Number($('maxPerHour').value),
        maxPerDay: Number($('maxPerDay').value),
        minGapSeconds: Number($('minGapSeconds').value),
      },
    });
    paintQuota(res.quota);
    toast('Limits saved', 'good');
  } catch (err) { toast(friendly(err), 'bad'); }
};

$('refreshDeck').onclick = () => { closeSheet(); cards = []; loadDeck({ refresh: true }); };
quotaEl.onclick = openSheet;

document.addEventListener('keydown', (e) => {
  if (!sheet.classList.contains('hidden')) return;
  if (e.key === 'ArrowLeft') swipeTop('left');
  if (e.key === 'ArrowRight') swipeTop('right');
});

// iOS: stop the page itself from panning behind the deck.
document.addEventListener('touchmove', (e) => {
  if (sheet.classList.contains('hidden')) e.preventDefault();
}, { passive: false });

refreshState();
loadDeck();
