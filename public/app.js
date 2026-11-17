'use strict';

/* ---------- api ---------- */

const KEY_STORE = 'matchedin.key';
const LEGACY_KEY_STORE = 'inswipe.key';   // the app was called in·swipe once

// Safari in private mode throws on localStorage, and a throw out here would
// take the whole script with it — leaving a page that looks loaded and does
// nothing. Fall back to memory and carry on.
const fallback = new Map();
const remember = {
  get(name) {
    try { return localStorage.getItem(name); } catch { return fallback.get(name) ?? null; }
  },
  set(name, value) {
    try { localStorage.setItem(name, value); } catch { fallback.set(name, value); }
  },
};

const params = new URLSearchParams(location.search);
if (params.get('k')) {
  remember.set(KEY_STORE, params.get('k'));
  history.replaceState(null, '', location.pathname);
}

// Not const: added to the home screen, iOS gives the app its own storage, so
// the key often has to be typed in once on the phone itself.
let KEY = remember.get(KEY_STORE) || remember.get(LEGACY_KEY_STORE) || '';

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
const keyForm = $('keyForm');
const keyInput = $('keyInput');
const loginSheet = $('login');
const loginPhase = $('loginPhase');
const loginPhaseText = $('loginPhaseText');

/* ---------- state ---------- */

let cards = [];
let busy = false;
let lastQuota = null;

const SWIPE_DISTANCE = 110;   // a deliberate drag
const SWIPE_VELOCITY = 0.45;  // or a flick, if it also travels far enough
const FLICK_DISTANCE = 70;
// The right swipe sends something to a real person and cannot be taken back,
// so it asks for a longer movement than the skip does.
const INVITE_EFFORT = 1.3;

function decideSwipe(dx, elapsedMs) {
  const distance = Math.abs(dx);
  const effort = dx > 0 ? INVITE_EFFORT : 1;
  const velocity = distance / Math.max(1, elapsedMs);
  const dragged = distance > SWIPE_DISTANCE * effort;
  const flicked = velocity > SWIPE_VELOCITY && distance > FLICK_DISTANCE * effort;
  return dragged || flicked;
}

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
  keyForm?.classList.add('hidden');
  emptyAction.classList.toggle('hidden', !action);
  if (action) {
    emptyAction.textContent = action.label;
    emptyAction.onclick = action.run;
  }
}

/** No key, or the wrong one: let it be typed in right here. */
function askForKey(title = 'Access key needed') {
  showEmpty(title, 'It is in the link the server printed on your Mac, after ?k=');
  if (!keyForm) return;
  keyForm.classList.remove('hidden');
  if (keyInput) keyInput.value = '';
}

/* ---------- rendering ---------- */

/** Scraped URLs are only ever loaded when they are plainly https. */
function safeImageUrl(url) {
  return /^https:\/\/[^\s"'()<>]+$/i.test(url || '') ? url : null;
}

function buildCard(card, depth) {
  const el = document.createElement('article');
  el.className = 'card';
  el.dataset.depth = String(depth);
  el.dataset.slug = card.slug;

  const initial = (card.name || '?').trim().charAt(0).toUpperCase();
  // Everything on a card was scraped off a web page. None of it is interpolated
  // into this markup — the shell is a constant, and every value goes in through
  // the DOM below, as text or through a property.
  el.innerHTML = `
    <div class="card-backdrop hidden"></div>
    <div class="card-portrait">
      <img class="card-avatar hidden" alt="" referrerpolicy="no-referrer" loading="eager">
      <div class="card-avatar card-initial hidden"></div>
    </div>
    <div class="card-shade"></div>
    <div class="stamp stamp-yes">CONNECT</div>
    <div class="stamp stamp-no">SKIP</div>
    <div class="card-body">
      <h2 class="card-name"><span class="nm"></span><span class="card-degree hidden"></span></h2>
      <p class="card-headline hidden"></p>
      <p class="card-mutuals hidden"></p>
    </div>`;

  const show = (selector, text) => {
    const node = el.querySelector(selector);
    if (text) { node.textContent = text; node.classList.remove('hidden'); }
    return node;
  };

  show('.nm', card.name || 'Unknown');
  show('.card-degree', card.degree);
  show('.card-headline', card.headline);
  show('.card-mutuals', card.mutuals);

  // A URL off that page is only ever https, and it is set as a property, never
  // written into an attribute.
  const photo = safeImageUrl(card.photo);
  const backdrop = safeImageUrl(card.banner) || photo;
  if (photo) {
    el.querySelector('.card-avatar').src = photo;
    el.querySelector('.card-avatar').classList.remove('hidden');
  } else {
    show('.card-initial', initial);
  }
  // LinkedIn avatars top out at 400px, so blowing one up full-bleed looks mushy.
  // A blurred copy fills the card and the crisp original sits on top.
  if (backdrop) {
    const layer = el.querySelector('.card-backdrop');
    layer.style.backgroundImage = `url("${encodeURI(backdrop)}")`;
    layer.classList.remove('hidden');
  }

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

    if (decideSwipe(dx, performance.now() - startT)) {
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
      // Nothing to say: the card flew off and the quota pill ticked up.
      // Only the things that did not work are worth interrupting for.
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
      askForKey('Wrong access key');
    } else if (/not signed in/i.test(err.message)) {
      showEmpty('LinkedIn is not signed in', 'Sign in once and the deck fills up.', { label: 'Sign in to LinkedIn', run: startLogin });
    } else {
      showEmpty('Could not load suggestions', friendly(err), { label: 'Retry', run: () => loadDeck({ refresh: true }) });
    }
  }
}

/* ---------- sign-in ---------- */

// The password is typed into LinkedIn's own page in Chrome on the Mac — never
// into this app. All we wait for is the session cookie that login leaves behind.
const LOGIN_TIMEOUT = 10 * 60 * 1000;
const PHASE_TEXT = {
  waiting: 'Waiting for you to sign in, in the Chrome window on your Mac…',
  checkpoint: 'LinkedIn wants a verification code — answer it in that Chrome window.',
  done: 'Signed in. Session captured.',
};

let loginTimer = null;

function setPhase(text, kind = '') {
  loginPhaseText.textContent = text;
  loginPhase.className = `phase ${kind}`;
}

function closeLogin() {
  clearTimeout(loginTimer);
  loginTimer = null;
  loginSheet.classList.add('hidden');
}

/** The server does not know us. Nothing about LinkedIn can help — ask for the key. */
function keyProblem() {
  closeLogin();
  closeSheet();
  askForKey('Wrong access key');
}

async function startLogin() {
  closeSheet();
  loginSheet.classList.remove('hidden');
  setPhase('Opening LinkedIn in Chrome on your Mac…');
  try {
    const res = await api('/api/login', { method: 'POST' });
    if (res.phase === 'done') return loginDone();
    setPhase(PHASE_TEXT[res.phase] || PHASE_TEXT.waiting);
    pollLogin(Date.now() + LOGIN_TIMEOUT);
  } catch (err) {
    if (err.status === 401) return keyProblem();
    setPhase(friendly(err), 'bad');
  }
}

function pollLogin(deadline) {
  clearTimeout(loginTimer);
  loginTimer = setTimeout(async () => {
    if (loginSheet.classList.contains('hidden')) return;
    try {
      const res = await api('/api/login/status');
      if (res.phase === 'done') return loginDone();
      setPhase(PHASE_TEXT[res.phase] || PHASE_TEXT.waiting);
    } catch (err) {
      if (err.status === 401) return keyProblem();
      setPhase(friendly(err), 'bad');
    }
    if (Date.now() > deadline) {
      setPhase('Stopped waiting. Tap Sign in again when you have finished in Chrome.', 'bad');
      return;
    }
    pollLogin(deadline);
  }, 2000);
}

function loginDone() {
  clearTimeout(loginTimer);
  loginTimer = null;
  setPhase(PHASE_TEXT.done, 'done');
  toast('Signed in to LinkedIn', 'good');
  setTimeout(() => loginSheet.classList.add('hidden'), 800);
  cards = [];
  loadDeck({ refresh: true });
  refreshState();
}

/* ---------- settings ---------- */

async function refreshState() {
  try {
    const s = await api('/api/state');
    paintQuota(s.quota);
    const li = s.linkedIn || {};
    $('sessionState').textContent = li.loggedIn
      ? `Signed in and ready.${li.cookiePreview ? ` Session cookie li_at ${li.cookiePreview}.` : ''}`
      : 'Not signed in to LinkedIn.';
    $('signIn').textContent = li.loggedIn ? 'Sign in again' : 'Sign in to LinkedIn';
    $('maxPerHour').value = s.settings.maxPerHour;
    $('maxPerDay').value = s.settings.maxPerDay;
    $('minGapSeconds').value = s.settings.minGapSeconds;
    $('statsLine').textContent = `${s.stats.sent} sent · ${s.stats.passed} skipped · ${s.stats.failed} failed`;
  } catch (err) {
    if (err.status === 401) return askForKey('Wrong access key');
    const line = $('sessionState');
    if (line) line.textContent = friendly(err);
  }
}

function openSheet() { sheet.classList.remove('hidden'); refreshState(); }
function closeSheet() { sheet.classList.add('hidden'); }

/* ---------- wiring ---------- */

const on = (id, event, handler) => $(id)?.addEventListener(event, handler);

on('btnPass', 'click', () => swipeTop('left'));
on('btnConnect', 'click', () => swipeTop('right'));
on('btnUndo', 'click', async () => {
  try {
    const res = await api('/api/undo', { method: 'POST' });
    if (!res.ok) return toast(res.error || 'Nothing to undo.');
    toast(`${res.restored} is back in the deck`);
    cards = [];
    await loadDeck();
  } catch (err) { toast(friendly(err), 'bad'); }
});

on('keyForm', 'submit', (e) => {
  e.preventDefault();
  const value = keyInput.value.trim().replace(/^.*[?&]k=/, '');
  if (!value) return toast('Paste the key, or the whole link.');
  KEY = value;
  remember.set(KEY_STORE, value);
  keyForm.classList.add('hidden');
  showEmpty('Loading suggestions…');
  refreshState();
  loadDeck();
});

on('signIn', 'click', startLogin);
on('loginCancel', 'click', closeLogin);

on('openSettings', 'click', openSheet);
on('closeSettings', 'click', closeSheet);
sheet.addEventListener('click', (e) => { if (e.target === sheet) closeSheet(); });
loginSheet.addEventListener('click', (e) => { if (e.target === loginSheet) closeLogin(); });

on('saveSession', 'click', async () => {
  const value = $('liAt').value.trim();
  if (!value) return toast('Paste the cookie value first.');
  $('sessionState').textContent = 'Signing in…';
  try {
    const res = await api('/api/session', { method: 'POST', body: { li_at: value } });
    $('liAt').value = '';
    $('sessionState').textContent = res.linkedIn?.loggedIn ? 'Signed in and ready.' : 'LinkedIn did not accept that cookie.';
    if (res.linkedIn?.loggedIn) { closeSheet(); cards = []; loadDeck({ refresh: true }); }
  } catch (err) { $('sessionState').textContent = friendly(err); }
});

on('saveLimits', 'click', async () => {
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
});

on('refreshDeck', 'click', () => { closeSheet(); cards = []; loadDeck({ refresh: true }); });
on('quota', 'click', openSheet);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeLogin(); closeSheet(); return; }
  if (!sheet.classList.contains('hidden') || !loginSheet.classList.contains('hidden')) return;
  if (e.key === 'ArrowLeft') swipeTop('left');
  if (e.key === 'ArrowRight') swipeTop('right');
});

// iOS: stop the page itself from panning behind the deck.
document.addEventListener('touchmove', (e) => {
  if (sheet.classList.contains('hidden') && loginSheet.classList.contains('hidden')) e.preventDefault();
}, { passive: false });

if (KEY) {
  refreshState();
  loadDeck();
} else {
  askForKey('Access key needed');
}
