// Everything that knows about LinkedIn's DOM lives here.
// We read the rendered page instead of its internal API: LinkedIn now serves
// My Network through server-driven UI (protobuf over /flagship-web/rsc-action),
// so the old Voyager JSON endpoints no longer answer for suggestions or invites.
import { setTimeout as sleep } from 'node:timers/promises';

export const FEED_URL = 'https://www.linkedin.com/mynetwork/grow/';
export const LOGIN_URL = 'https://www.linkedin.com/login';

/** Enough of the cookie to recognise it, never enough to use it. */
const preview = (value) => (value ? `${value.slice(0, 4)}…${value.slice(-4)}` : null);

const slugOf = (url) => {
  const m = String(url || '').match(/\/in\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]).toLowerCase() : null;
};

// --- page-side snippets -----------------------------------------------------

const EXTRACT = `
  const seen = new Map();
  for (const btn of document.querySelectorAll('button')) {
    const al = btn.getAttribute('aria-label') || '';
    const m = al.match(/^Invite (.+) to connect$/i);
    if (!m) continue;

    let card = btn, hops = 0;
    while (card && hops < 10 && !card.querySelector('a[href*="/in/"]')) { card = card.parentElement; hops++; }
    if (!card) continue;

    const link = card.querySelector('a[href*="/in/"]');
    if (!link) continue;
    const url = link.href.split('?')[0];
    if (seen.has(url)) continue;

    // A card holds up to three images: the banner (profile-displaybackgroundimage),
    // this person's avatar at 400px, and a 100px avatar of a *mutual connection*.
    // An avatar is profile-displayphoto, or profile-framedphoto when the person
    // wears an #OpenToWork / #Hiring frame.
    const pics = [...card.querySelectorAll('img')]
      .map(i => ({ src: i.src || '', size: i.naturalWidth || i.width || 0 }))
      .filter(p => p.src && !p.src.includes('displaybackgroundimage'));

    const avatars = pics.filter(p => /profile-(displayphoto|framedphoto)/.test(p.src));
    const pool = avatars.length ? avatars : pics;
    const photo = pool.sort((a, b) => b.size - a.size)[0]?.src || null;

    const banner = [...card.querySelectorAll('img')]
      .map(i => i.src || '')
      .find(s => s.includes('displaybackgroundimage')) || null;

    const name = m[1].trim();
    const lines = (card.innerText || '').split('\\n').map(s => s.trim()).filter(Boolean);
    const at = lines.findIndex(s => s.startsWith(name));
    const rest = at >= 0 ? lines.slice(at + 1) : lines;
    const skip = s => s === 'Connect' || /mutual connection/i.test(s) || /^·|^•/.test(s);

    seen.set(url, {
      name,
      url,
      photo,
      banner,
      headline: rest.find(s => !skip(s)) || null,
      mutuals: lines.find(s => /mutual connection/i.test(s)) || null,
      degree: (lines.find(s => /•\\s*(1st|2nd|3rd)/.test(s)) || '').match(/(1st|2nd|3rd)/)?.[1] || null,
    });
  }
  return [...seen.values()];
`;

// LinkedIn's server-driven shell has no stable id on its nav, so we look for
// several independent signs of an authenticated page and accept any of them.
// A false positive only yields an empty deck; a false negative blocks everything.
const LOGGED_IN = `
  const path = location.pathname;
  if (/^\\/$|\\/login|\\/uas\\/|\\/checkpoint|\\/authwall|\\/signup/.test(path)) {
    return { loggedIn: false, reason: 'auth-page', url: location.href };
  }
  const navLink = !!document.querySelector('a[href*="/mynetwork"], a[href*="/jobs"], a[href*="/messaging"], a[href*="/feed"]');
  const navText = /My Network|Messaging|Notifications|\\u041c\\u043e\\u044f \\u0441\\u0435\\u0442\\u044c|\\u0421\\u043e\\u043e\\u0431\\u0449\\u0435\\u043d\\u0438\\u044f/i.test(document.body.innerText || '');
  const memberLink = !!document.querySelector('a[href*="/in/"]');
  const connectBtn = [...document.querySelectorAll('button')]
    .some(b => /^Invite .+ to connect$/i.test(b.getAttribute('aria-label') || ''));
  const loggedIn = navLink || navText || memberLink || connectBtn;
  return { loggedIn, url: location.href, signals: { navLink, navText, memberLink, connectBtn } };
`;

const scrollMore = (rounds) => `
  for (let i = 0; i < ${rounds}; i++) {
    window.scrollTo(0, document.body.scrollHeight);
    await new Promise(r => setTimeout(r, 1400));
  }
  window.scrollTo(0, 0);
  return document.body.scrollHeight;
`;

const rectForInvite = (slug) => `
  const slug = ${JSON.stringify(slug)};
  const link = [...document.querySelectorAll('a[href*="/in/"]')]
    .find(a => (a.getAttribute('href') || '').toLowerCase().includes('/in/' + slug));
  if (!link) return { ok: false, reason: 'card-gone' };

  let card = link, hops = 0, btn = null;
  while (card && hops < 10 && !btn) {
    btn = [...card.querySelectorAll('button')].find(b => /^Invite .+ to connect$/i.test(b.getAttribute('aria-label') || ''));
    if (!btn) { card = card.parentElement; hops++; }
  }
  if (!btn) return { ok: false, reason: 'no-connect-button' };

  // Hold on to the exact button. Afterwards it is the only honest witness to
  // whether the invite went out — the surrounding card's text is not, because
  // the ancestor we had to climb to also holds other people's cards.
  window.__matchedInTarget = { slug, btn, label: btn.getAttribute('aria-label') || '' };

  btn.scrollIntoView({ block: 'center', behavior: 'instant' });
  await new Promise(r => setTimeout(r, 450));
  const r = btn.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return { ok: false, reason: 'button-not-visible' };
  return { ok: true, x: r.x + r.width / 2, y: r.y + r.height / 2, label: btn.getAttribute('aria-label') };
`;

// Where that same button sits now, so a second attempt cannot land on a
// different control — clicking a button that has turned into "Pending" would
// withdraw the invitation we just sent.
const rectForRetry = (slug) => `
  const t = window.__matchedInTarget;
  if (!t || t.slug !== ${JSON.stringify(slug)}) return { ok: false, reason: 'no-target' };
  if (!document.contains(t.btn)) return { ok: false, reason: 'gone' };
  if ((t.btn.getAttribute('aria-label') || '') !== t.label) return { ok: false, reason: 'changed' };
  t.btn.scrollIntoView({ block: 'center', behavior: 'instant' });
  await new Promise(r => setTimeout(r, 350));
  const r = t.btn.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return { ok: false, reason: 'invisible' };
  return { ok: true, x: r.x + r.width / 2, y: r.y + r.height / 2 };
`;

// After clicking Connect, LinkedIn sometimes opens a modal asking for a note.
// We only ever take the "send without a note" path — the app sends no message.
const MODAL_RECT = `
  const dialog = document.querySelector('[role="dialog"]');
  if (!dialog) return { present: false };
  const pick = [...dialog.querySelectorAll('button')].find(b => {
    const t = ((b.innerText || '') + ' ' + (b.getAttribute('aria-label') || '')).toLowerCase();
    return t.includes('send without a note') || t.includes('send without note');
  }) || [...dialog.querySelectorAll('button')].find(b => /^send( invitation)?$/i.test((b.innerText || '').trim()));
  if (!pick) return { present: true, actionable: false };
  pick.scrollIntoView({ block: 'center', behavior: 'instant' });
  await new Promise(r => setTimeout(r, 250));
  const r = pick.getBoundingClientRect();
  return { present: true, actionable: true, x: r.x + r.width / 2, y: r.y + r.height / 2 };
`;

const confirmSent = (slug) => `
  const slug = ${JSON.stringify(slug)};
  const t = window.__matchedInTarget;
  const mine = t && t.slug === slug ? t : null;

  // Everything here keys on this person's own button — never on text scraped
  // from a container, which holds other people's cards and their "Pending".
  if (mine) {
    const label = mine.btn.getAttribute('aria-label') || '';
    const text = (mine.btn.innerText || '').trim().toLowerCase();

    if (document.contains(mine.btn)) {
      if (label !== mine.label || /pending|invitation sent/.test(text)) {
        return { sent: true, how: 'button-changed' };
      }
      return { sent: false, how: 'button-still-there' };
    }

    // The node is gone. A re-render puts the same Connect back; a sent invite
    // does not — LinkedIn either drops the card or marks it pending.
    const sameAgain = [...document.querySelectorAll('button')]
      .some(b => (b.getAttribute('aria-label') || '') === mine.label);
    if (sameAgain) return { sent: false, how: 're-rendered' };
    return { sent: true, how: 'button-gone' };
  }

  const link = [...document.querySelectorAll('a[href*="/in/"]')]
    .find(a => (a.getAttribute('href') || '').toLowerCase().includes('/in/' + slug));
  if (!link) return { sent: true, how: 'card-removed' };
  const still = [...document.querySelectorAll('button')]
    .some(b => /^Invite .+ to connect$/i.test(b.getAttribute('aria-label') || ''));
  return { sent: !still, how: still ? 'button-still-there' : 'button-replaced' };
`;

// --- driver -----------------------------------------------------------------

export class LinkedIn {
  constructor(browser, { inviteTimeout = 9000, retryAfter = 3000 } = {}) {
    this.browser = browser;
    this.inviteTimeout = inviteTimeout;   // how long to watch for LinkedIn's answer
    this.retryAfter = retryAfter;         // when to try the click once more
  }

  /** The session cookie itself — present only once LinkedIn has signed us in. */
  async sessionCookie() {
    const value = await this.browser.cookieValue('li_at').catch(() => null);
    return value && value.length > 20 ? value : null;
  }

  async status() {
    let url = await this.browser.currentUrl();
    if (!/linkedin\.com/.test(url || '')) await this.browser.navigate(FEED_URL);
    let state = await this.browser.evaluate(LOGGED_IN);
    const cookie = await this.sessionCookie();

    // A sign-in that happened in another tab only shows up here after a reload.
    if (!state.loggedIn && cookie) {
      await this.browser.navigate(FEED_URL, { waitMs: 4500 });
      state = await this.browser.evaluate(LOGGED_IN);
    }
    return { ...state, cookie: !!cookie, cookiePreview: preview(cookie), url: state.url || url };
  }

  /**
   * Open LinkedIn's own login page in the Chrome we drive and raise its window.
   * The person types their password and answers 2FA there — we never see either,
   * and we never fill a credential field ourselves. All we take is the cookie
   * LinkedIn hands that profile afterwards.
   */
  async startLogin() {
    await this.browser.reattach().catch(() => {});
    if (await this.sessionCookie()) return this.loginStatus();
    await this.browser.navigate(LOGIN_URL, { waitMs: 1800 });
    await this.browser.bringToFront();
    return this.loginStatus();
  }

  /** Where the sign-in has got to: waiting, a 2FA checkpoint, or done. */
  async loginStatus() {
    const cookie = await this.sessionCookie();
    let url = await this.browser.currentUrl().catch(() => '');

    if (!/linkedin\.com/.test(url || '')) {
      await this.browser.reattach().catch(() => {});
      url = await this.browser.currentUrl().catch(() => '');
    }

    if (cookie) {
      if (!/linkedin\.com\/mynetwork/.test(url || '')) {
        await this.browser.navigate(FEED_URL, { waitMs: 4500 });
      }
      const state = await this.browser.evaluate(LOGGED_IN).catch(() => ({ loggedIn: true }));
      return {
        phase: 'done', loggedIn: true, cookie: true, cookiePreview: preview(cookie),
        url: state.url || url,
      };
    }

    const phase = /\/checkpoint|\/uas\/consumer-email-challenge/.test(url || '') ? 'checkpoint' : 'waiting';
    return { phase, loggedIn: false, cookie: false, url };
  }

  /** Put the session cookie in place, then reload so the page picks it up. */
  async signInWithCookie(liAt) {
    // Order matters: a value copied out of devtools arrives as li_at="…";
    // stripping the quotes before the semicolon leaves a quote behind.
    const clean = String(liAt).trim()
      .replace(/^li_at\s*=\s*/i, '')
      .replace(/;\s*$/, '')
      .replace(/^"(.*)"$/, '$1')
      .trim();
    if (!clean || clean.length < 20) throw new Error('That does not look like an li_at value.');
    await this.browser.setCookie('li_at', clean, '.linkedin.com');
    await this.browser.setCookie('li_at', clean, '.www.linkedin.com');
    await this.browser.navigate(FEED_URL, { waitMs: 5000 });
    return this.status();
  }

  async ensureFeedPage() {
    const url = await this.browser.currentUrl();
    if (!/linkedin\.com\/mynetwork/.test(url || '')) {
      await this.browser.navigate(FEED_URL, { waitMs: 4500 });
    }
  }

  /** Scroll the suggestions page and return every card we can see. */
  async fetchCards({ rounds = 3 } = {}) {
    await this.ensureFeedPage();
    const { loggedIn } = await this.browser.evaluate(LOGGED_IN);
    if (!loggedIn) throw Object.assign(new Error('Not signed in to LinkedIn.'), { code: 'NO_SESSION' });
    if (rounds > 0) await this.browser.evaluate(scrollMore(rounds));
    const cards = await this.browser.evaluate(EXTRACT);
    return (cards || []).map((c) => ({ ...c, slug: slugOf(c.url) })).filter((c) => c.slug);
  }

  async refreshFeed() {
    await this.browser.navigate(FEED_URL, { waitMs: 4500 });
  }

  /**
   * Send a connection request, with no note, to one profile.
   * Returns { sent, how } or throws with a code the API layer can report.
   */
  async invite(slug) {
    // Unthrottle the tab first: a frozen page takes the click and does nothing.
    await this.browser.keepAwake();
    const spot = await this.browser.evaluate(rectForInvite(slug));
    if (!spot.ok) {
      // The card may have scrolled out of the loaded set; reload once and retry.
      await this.refreshFeed();
      await this.browser.evaluate(scrollMore(2));
      const retry = await this.browser.evaluate(rectForInvite(slug));
      if (!retry.ok) throw Object.assign(new Error(`Connect button unavailable (${spot.reason})`), { code: 'NO_BUTTON' });
      Object.assign(spot, retry);
    }

    await this.browser.clickAt(spot.x, spot.y);

    // LinkedIn answers the click in its own time — sometimes with a note modal,
    // sometimes by turning the button into "Pending". Watch for either rather
    // than guessing at one delay.
    const deadline = Date.now() + this.inviteTimeout;
    const retryAt = Date.now() + this.retryAfter;
    let modalClicked = false;
    let retried = false;
    let blocked = 0;

    while (Date.now() < deadline) {
      await sleep(400);

      // The dialog comes first: a card sitting behind an open modal tells us
      // nothing, and leaving one open breaks the next invite too.
      const modal = await this.browser.evaluate(MODAL_RECT);
      if (modal.present && modal.actionable && !modalClicked) {
        modalClicked = true;
        await this.browser.clickAt(modal.x, modal.y);
        continue;
      }
      // One sighting can just be a half-rendered dialog; two in a row is real.
      if (modal.present && !modal.actionable && ++blocked >= 2) {
        throw Object.assign(new Error('LinkedIn asked for something this app will not answer (note or email).'), { code: 'MODAL_BLOCKED' });
      }
      if (!modal.present) blocked = 0;

      const check = await this.browser.evaluate(confirmSent(slug));
      if (check.sent) return check;

      // Nothing moved and no dialog appeared: the click was swallowed. Try once
      // more, but only at the same button while it still says "Connect".
      if (!retried && !modal.present && Date.now() > retryAt) {
        retried = true;
        const again = await this.browser.evaluate(rectForRetry(slug));
        if (again.ok) await this.browser.clickAt(again.x, again.y);
      }
    }

    throw Object.assign(new Error('Click did not register as an invite.'), { code: 'NOT_CONFIRMED' });
  }
}

// The page-side snippets are the part most likely to drift when LinkedIn
// reshuffles its DOM, so they are reachable for a read-only smoke test.
export const pageSnippets = { EXTRACT, LOGGED_IN, rectForInvite, rectForRetry, confirmSent, MODAL_RECT };
