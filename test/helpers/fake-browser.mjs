// A Browser stand-in for the unit tests.
//
// The driver talks to the page by evaluating snippets of JavaScript, so this
// fake recognises each snippet by a phrase only that snippet contains, and
// answers from a queue the test sets up. Last answer in a queue repeats, which
// keeps the polling loops from running dry.
export const KINDS = {
  loggedIn: 'auth-page',
  extract: 'displaybackgroundimage',
  scroll: 'document.body.scrollHeight',
  rect: 'no-connect-button',
  retryRect: 'no-target',
  confirm: 're-rendered',
  modal: 'send without a note',
};

export class FakeBrowser {
  constructor(answers = {}) {
    this.answers = { ...answers };
    this.calls = [];            // every evaluate, by kind
    this.clicks = [];           // every clickAt, as [x, y]
    this.navigations = [];
    this.cookies = {};
    this.url = 'https://www.linkedin.com/mynetwork/grow/';
    this.awake = 0;
    this.fronted = 0;
    this.reattached = 0;
  }

  static kindOf(expression) {
    for (const [kind, marker] of Object.entries(KINDS)) {
      if (expression.includes(marker)) return kind;
    }
    return 'unknown';
  }

  async evaluate(expression) {
    const kind = FakeBrowser.kindOf(expression);
    this.calls.push(kind);
    const queue = this.answers[kind];
    if (queue === undefined) throw new Error(`FakeBrowser has no answer for "${kind}"`);
    if (!Array.isArray(queue)) return queue;
    return queue.length > 1 ? queue.shift() : queue[0];
  }

  async clickAt(x, y) { this.clicks.push([x, y]); }
  async navigate(url) { this.navigations.push(url); this.url = url; }
  async currentUrl() { return this.url; }
  async cookieValue(name) { return this.cookies[name] || null; }
  async setCookie(name, value) { this.cookies[name] = value; }
  async keepAwake() { this.awake++; }
  async bringToFront() { this.fronted++; }
  async reattach() { this.reattached++; }

  countOf(kind) { return this.calls.filter((c) => c === kind).length; }
}
