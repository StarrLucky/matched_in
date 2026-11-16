// Swipe history, settings and invite throttling, persisted to one JSON file.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

const DEFAULTS = {
  // Deliberately well under LinkedIn's own ceilings. Bursts are what get accounts flagged.
  maxPerHour: 12,
  maxPerDay: 35,
  minGapSeconds: 6,
};

export class Store {
  constructor(file) {
    this.file = file;
    this.state = {
      settings: { ...DEFAULTS },
      swipes: [],      // { slug, name, url, dir, at, sent, error }
      lastInviteAt: 0,
    };
    this.load();
  }

  load() {
    if (!existsSync(this.file)) return;
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8'));
      this.state = {
        ...this.state,
        ...raw,
        settings: { ...DEFAULTS, ...(raw.settings || {}) },
        swipes: Array.isArray(raw.swipes) ? raw.swipes : [],
      };
    } catch {
      // A corrupt file should not stop the app; we just start clean.
    }
  }

  save() {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.state, null, 2));
  }

  get settings() { return this.state.settings; }

  updateSettings(patch) {
    const next = { ...this.state.settings };
    for (const key of ['maxPerHour', 'maxPerDay', 'minGapSeconds']) {
      if (patch[key] !== undefined) {
        const n = Number(patch[key]);
        if (Number.isFinite(n) && n >= 0) next[key] = Math.min(n, key === 'maxPerDay' ? 150 : 100);
      }
    }
    this.state.settings = next;
    this.save();
    return next;
  }

  /** Slugs already swiped, so the deck never shows the same person twice. */
  seenSlugs() {
    return new Set(this.state.swipes.map((s) => s.slug));
  }

  record(entry) {
    this.state.swipes.push({ at: Date.now(), ...entry });
    if (entry.dir === 'right' && entry.sent) this.state.lastInviteAt = Date.now();
    this.save();
  }

  /** Drop the most recent left swipe so the card can come back. */
  undoLastPass() {
    for (let i = this.state.swipes.length - 1; i >= 0; i--) {
      if (this.state.swipes[i].dir === 'left') {
        const [removed] = this.state.swipes.splice(i, 1);
        this.save();
        return removed;
      }
    }
    return null;
  }

  sentSince(ms) {
    const cutoff = Date.now() - ms;
    return this.state.swipes.filter((s) => s.dir === 'right' && s.sent && s.at >= cutoff).length;
  }

  quota() {
    const { maxPerHour, maxPerDay, minGapSeconds } = this.state.settings;
    const hour = this.sentSince(3600_000);
    const day = this.sentSince(86_400_000);
    const sinceLast = (Date.now() - this.state.lastInviteAt) / 1000;
    return {
      hour, maxPerHour,
      day, maxPerDay,
      hourLeft: Math.max(0, maxPerHour - hour),
      dayLeft: Math.max(0, maxPerDay - day),
      waitSeconds: Math.max(0, Math.ceil(minGapSeconds - sinceLast)),
    };
  }

  /** Why an invite cannot be sent right now, or null if it can. */
  blockReason() {
    const q = this.quota();
    if (q.dayLeft <= 0) return { code: 'DAY_LIMIT', message: `Daily limit reached (${q.maxPerDay}). Try again tomorrow.` };
    if (q.hourLeft <= 0) return { code: 'HOUR_LIMIT', message: `Hourly limit reached (${q.maxPerHour}). Take a break.` };
    if (q.waitSeconds > 0) return { code: 'TOO_FAST', message: `Slow down — ${q.waitSeconds}s to go.`, waitSeconds: q.waitSeconds };
    return null;
  }

  stats() {
    const right = this.state.swipes.filter((s) => s.dir === 'right');
    return {
      total: this.state.swipes.length,
      passed: this.state.swipes.filter((s) => s.dir === 'left').length,
      sent: right.filter((s) => s.sent).length,
      failed: right.filter((s) => !s.sent).length,
    };
  }

  recent(limit = 50) {
    return this.state.swipes.slice(-limit).reverse();
  }
}
