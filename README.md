# matched_in

A Tinder-style swipe deck for LinkedIn connection suggestions, built to be used from an iPhone.

Swipe **right** to send a connection request with no note. Swipe **left** to skip.
Nothing else happens — no messages, no follows, no profile edits.

```
iPhone (Safari / home-screen app)
        │  http over your Wi-Fi
        ▼
Node server on your Mac  ──CDP──▶  Chrome (dedicated profile, signed in to LinkedIn)
                                        │
                                        ▼
                               linkedin.com/mynetwork/grow
```

## Why it drives a browser instead of calling an API

LinkedIn has no public API for "People you may know" or for sending invitations, and as of
late 2026 the web app serves My Network through server-driven UI — the page talks to
`/flagship-web/rsc-action/...` in protobuf blobs tied to server-rendered page state. The old
Voyager JSON endpoints answer `{"status":400}` for suggestions and invites.

So the server reads the rendered page and clicks the real **Connect** button, using CDP
`Input.dispatchMouseEvent` so the clicks are genuine trusted events. Nothing sets
`navigator.webdriver`. When LinkedIn reshuffles its internal APIs again, this keeps working.

## Setup

Requires Node 22+ and Google Chrome. No npm install — there are no dependencies.

```bash
cd matched_in
npm start
```

On first run the server launches Chrome on its **own profile** (`data/chrome-profile`), separate
from the Chrome you use day to day, and prints two URLs with an access key:

```
On your iPhone (same Wi-Fi):  http://192.168.x.x:7777/?k=ab12cd34ef56
On this Mac:                  http://localhost:7777/?k=ab12cd34ef56
```

Open the app and tap **Sign in to LinkedIn** (Settings → LinkedIn session). That opens LinkedIn's
own login page in the Chrome window on your Mac and raises it; you type the password and answer 2FA
there, and the app watches for the `li_at` cookie the login leaves in that profile and closes the
waiting screen by itself. The app never asks for your password and never fills a credential field.

If you would rather carry a session over from another browser, Settings → *Paste a cookie instead*
takes the `li_at` value directly. Either way the session persists in the profile, so you do this once.

On the iPhone, open the URL in Safari and use **Share → Add to Home Screen**. It then runs
full-screen with no browser chrome.

### Demo mode

```bash
npm run demo
```

Fixture profiles, no Chrome, no LinkedIn, nothing sent. Useful for trying the feel of the deck.

## Which Chrome it drives

The server only ever drives the Chrome **it started itself**, recorded in `data/chrome-profile.lock`
along with its port and pid. If something else already holds the debugging port — Vivaldi, Brave,
Edge or a Chrome you started with `--remote-debugging-port` yourself — the server steps over it and
takes the next free port, and says so on startup:

```
Ports 9222 belong to another browser — not touching it.
Chrome profile: …/data/chrome-profile (just launched) on port 9223
```

That matters: attaching to the wrong browser would mean clicking Connect in a window you are using.

If you quit that Chrome window, the next `npm start` opens a new one. If you see
*"A Chrome is already using …"*, a window with that profile is open outside the server's knowledge —
quit it and start again.

## Rate limits

Defaults: **12 invites/hour, 35/day, 6 seconds apart** — all editable in Settings.

These are deliberately well under LinkedIn's own ceilings. LinkedIn restricts accounts that send
invitations in bursts, and a restricted account is a far bigger problem than a slow deck. The
server refuses to exceed them; the card comes back into the deck instead of being lost.

## What is stored

Everything lives in `matched_in/data/` and is gitignored:

- `state.json` — swipe history (so nobody reappears), settings, invite timestamps
- `chrome-profile/` — the Chrome profile holding the LinkedIn session

The `li_at` value is never written to `state.json`; it lives only in Chrome's own cookie store.

## Access key

The server binds `0.0.0.0` so your phone can reach it, which also means anyone on the same
Wi-Fi could. Every `/api/*` call requires the key from the printed URL. The app stores it in
`localStorage` after the first load. Set your own with `SWIPE_KEY=…` if you prefer a stable URL.

## Controls

| | |
|---|---|
| Swipe right / `→` / green **+** | Send connection request, no note |
| Swipe left / `←` / red **✕** | Skip |
| **↺** | Undo the last skip (does not unsend invites) |
| Quota pill | Opens Settings |

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `7777` | HTTP port for the app |
| `CDP_PORT` | `9222` | First debugging port to try; busy ports are skipped |
| `SWIPE_KEY` | random | Access key; random each start unless set |
| `CHROME_BIN` | auto | Path to Chrome/Chromium/Edge/Brave |
| `DEMO` | — | `1` for fixture mode |

## Working on it

```bash
make          # lint, unit tests, end-to-end tests
make help     # everything you can run
```

`make lint` parses every file, the snippets that run inside the LinkedIn page included —
those live in template strings, so no parser would otherwise see them. `make unit` covers
the throttling in the store and the driver's decisions, with the page faked out. `make e2e`
runs this server over real HTTP in demo mode and drives the app in headless Chrome, down to
a real drag on a card.

Nothing in the suite touches LinkedIn or your own session: the tests get a throwaway
`DATA_DIR` and their own Chrome profile, and demo mode never opens LinkedIn at all.

## Caveats

- Automating LinkedIn is against its Terms of Service. This is a personal tool, at human pace,
  on your own account. Keep the limits low.
- The Mac must stay awake with Chrome running while you swipe on the phone.
- If LinkedIn asks for a note or an email to connect, the app refuses and reports it rather than
  filling anything in — it only ever takes the "send without a note" path.
- Suggestions come from `linkedin.com/mynetwork/grow`. When LinkedIn runs out, the deck empties
  until it refreshes.
