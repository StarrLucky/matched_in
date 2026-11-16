// Everything that knows about LinkedIn's DOM lives here.
// We read the rendered page instead of its internal API: LinkedIn now serves
// My Network through server-driven UI (protobuf over /flagship-web/rsc-action),
// so the old Voyager JSON endpoints no longer answer for suggestions or invites.
import { setTimeout as sleep } from 'node:timers/promises';

export const FEED_URL = 'https://www.linkedin.com/mynetwork/grow/';

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

  btn.scrollIntoView({ block: 'center', behavior: 'instant' });
  await new Promise(r => setTimeout(r, 450));
  const r = btn.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return { ok: false, reason: 'button-not-visible' };
  return { ok: true, x: r.x + r.width / 2, y: r.y + r.height / 2, label: btn.getAttribute('aria-label') };
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
  const link = [...document.querySelectorAll('a[href*="/in/"]')]
    .find(a => (a.getAttribute('href') || '').toLowerCase().includes('/in/' + slug));
  if (!link) return { sent: true, how: 'card-removed' };
  let card = link, hops = 0, btn = null;
  while (card && hops < 10 && !btn) {
    btn = [...card.querySelectorAll('button')].find(b => /^Invite .+ to connect$/i.test(b.getAttribute('aria-label') || ''));
    if (!btn) { card = card.parentElement; hops++; }
  }
  if (!btn) return { sent: true, how: 'button-replaced' };
  const txt = ((card && card.innerText) || '').toLowerCase();
  if (txt.includes('pending') || txt.includes('invitation sent')) return { sent: true, how: 'pending-label' };
  return { sent: false, how: 'button-still-there' };
`;

// --- driver -----------------------------------------------------------------

export class LinkedIn {
  constructor(browser) { this.browser = browser; }

  async status() {
    const url = await this.browser.currentUrl();
    if (!/linkedin\.com/.test(url || '')) await this.browser.navigate(FEED_URL);
    const state = await this.browser.evaluate(LOGGED_IN);
    return { ...state, url: state.url || url };
  }

  /** Put the session cookie in place, then reload so the page picks it up. */
  async signInWithCookie(liAt) {
    const clean = String(liAt).trim().replace(/^li_at=/, '').replace(/^"|"$/g, '').replace(/;$/, '');
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
    await sleep(1200);

    const modal = await this.browser.evaluate(MODAL_RECT);
    if (modal.present && modal.actionable) {
      await this.browser.clickAt(modal.x, modal.y);
      await sleep(1200);
    } else if (modal.present && !modal.actionable) {
      throw Object.assign(new Error('LinkedIn asked for something this app will not answer (note or email).'), { code: 'MODAL_BLOCKED' });
    }

    const check = await this.browser.evaluate(confirmSent(slug));
    if (!check.sent) throw Object.assign(new Error('Click did not register as an invite.'), { code: 'NOT_CONFIRMED' });
    return check;
  }
}
