// The security gate.
//
// Two halves. First, the invariants this app lives by — the session cookie must
// never leave the machine, every API call must pass the access key, the browser
// must not be weakened, and nothing secret may be committed. Those are checked
// here, with no dependencies, because they are specific to this codebase and no
// generic scanner knows about them.
//
// Second, the scanners you may have installed — gitleaks, npm audit, semgrep.
// Each runs if it is there and is skipped with a note if it is not, so the gate
// works on a laptop with none of them and gets stricter on one that has them.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

const problems = [];
const notes = [];
const fail = (where, message) => problems.push({ where, message });
const skip = (what, why) => notes.push(`${what}: ${why}`);

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });

const have = (cmd) => {
  try { run('command', ['-v', cmd], { shell: true }); return true; }
  catch { return false; }
};

/* ---------- what is in the repository ---------- */

const tracked = run('git', ['ls-files']).split('\n').filter(Boolean);

// 1. Runtime state holds the LinkedIn session. It must never be committed.
const NEVER_TRACKED = [
  { pattern: /^data\//, what: 'runtime state (the Chrome profile and the swipe history)' },
  { pattern: /\.env$|\.env\./, what: 'an environment file' },
  { pattern: /\.(pem|key|p12|pfx|keystore)$/, what: 'a key file' },
  { pattern: /^coverage\//, what: 'a coverage report' },
];
for (const file of tracked) {
  for (const { pattern, what } of NEVER_TRACKED) {
    if (pattern.test(file)) fail(file, `${what} is committed`);
  }
}

const gitignore = read('.gitignore');
for (const must of ['data/', 'node_modules/']) {
  if (!gitignore.includes(must)) fail('.gitignore', `${must} is not ignored`);
}

// 2. Secrets in the files themselves. The patterns are the ones this project
//    could plausibly leak, plus the usual cloud credentials.
const SECRETS = [
  { name: 'linkedin-session-cookie', re: /\bAQED[A-Za-z0-9_-]{20,}/, says: 'a LinkedIn li_at cookie' },
  { name: 'hardcoded-access-key', re: /SWIPE_KEY\s*[=:]\s*['"][A-Za-z0-9]{8,}['"]/, says: 'a hardcoded access key' },
  { name: 'aws-key', re: /\bAKIA[0-9A-Z]{16}\b/, says: 'an AWS access key' },
  { name: 'private-key', re: /-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/, says: 'a private key' },
  { name: 'bearer-token', re: /\b[Aa]uthorization['"]?\s*[:=]\s*['"]Bearer\s+[A-Za-z0-9._-]{16,}/, says: 'a bearer token' },
  { name: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}/, says: 'a GitHub token' },
];
const TEXT = /\.(mjs|js|json|md|html|css|yml|yaml|properties|sh|webmanifest)$|^Makefile$|^\.gitignore$/;

for (const file of tracked.filter((f) => TEXT.test(f))) {
  const text = read(file);
  for (const { re, says } of SECRETS) {
    const hit = text.match(re);
    if (!hit) continue;
    const line = text.slice(0, hit.index).split('\n').length;
    fail(`${file}:${line}`, `looks like ${says}`);
  }
}

/* ---------- invariants of this app ---------- */

const server = read('server/server.mjs');
const linkedin = read('server/linkedin.mjs');
const chrome = read('server/chrome.mjs');
const app = read('public/app.js');

// 3. Every /api/* call is behind the access key, before anything is dispatched.
const guard = server.indexOf("key !== KEY");
const firstRoute = server.indexOf("route === '/api/");
if (guard === -1) fail('server/server.mjs', 'the access key check is gone');
else if (firstRoute !== -1 && guard > firstRoute) {
  fail('server/server.mjs', 'a route is handled before the access key is checked');
}

// 4. Static files never escape public/.
if (!server.includes('file.startsWith(PUBLIC)')) {
  fail('server/server.mjs', 'the path traversal guard on static files is gone');
}

// 5. The session cookie lives in Chrome's own store and nowhere else: the
//    module that handles it must not be able to write the history file.
if (/from '\.\/store\.mjs'/.test(linkedin)) {
  fail('server/linkedin.mjs', 'the LinkedIn driver can now write to the store — the cookie could land in state.json');
}
if (/(console\.\w+|res\.end|json\()[^\n]*\bli_at\b/.test(linkedin + server)) {
  fail('server', 'the session cookie is printed or returned somewhere');
}

// 6. Nothing may turn off the browser's own protections.
const WEAKENING = [
  '--no-sandbox',
  '--disable-web-security',
  '--allow-running-insecure-content',
  '--ignore-certificate-errors',
  '--disable-site-isolation-trials',
];
for (const flag of WEAKENING) {
  if (chrome.includes(flag)) fail('server/chrome.mjs', `Chrome is launched with ${flag}`);
}

// 7. Page snippets carry a profile slug into the LinkedIn page, where it
//    becomes code. Rather than grep for the escaping, hand each snippet a slug
//    that would break out and check that it cannot: the built snippet still
//    parses, and the hostile value sits inside a string literal.
const HOSTILE = '");throw new Error("pwned");("';
const { pageSnippets } = await import(new URL('../server/linkedin.mjs', import.meta.url));

for (const [name, snippet] of Object.entries(pageSnippets)) {
  if (typeof snippet !== 'function') continue;
  const source = snippet(HOSTILE);
  try {
    new Function(`return (async () => { ${source} })`);
  } catch {
    fail(`server/linkedin.mjs (${name})`, 'a profile slug can break out of the page snippet');
    continue;
  }
  if (!source.includes(JSON.stringify(HOSTILE))) {
    fail(`server/linkedin.mjs (${name})`, 'the slug does not go through JSON.stringify');
  }
}

// 8. A card is built from text scraped off a web page. None of it may be
//    interpolated into markup — the template is a constant and every value is
//    set through the DOM.
const template = app.match(/el\.innerHTML = `([\s\S]*?)`;/);
if (!template) {
  fail('public/app.js', 'the card template moved — check by hand how a card is built now');
} else if (template[1].includes('${')) {
  const what = template[1].match(/\$\{[^}]*\}/)[0];
  fail('public/app.js', `${what} is interpolated into the card markup; scraped values belong in the DOM`);
}
if (!/textContent = text/.test(app) || !app.includes("show('.nm'")) {
  fail('public/app.js', 'the profile name is no longer set as text');
}
if (!/safeImageUrl/.test(app) || !/\^https:/.test(app)) {
  fail('public/app.js', 'scraped image URLs are no longer restricted to https');
}

/* ---------- the scanners, if you have them ---------- */

if (have('gitleaks')) {
  try {
    run('gitleaks', ['detect', '--no-banner', '--redact', '--exit-code', '1']);
  } catch (err) {
    const out = `${err.stdout || ''}${err.stderr || ''}`.trim().split('\n').slice(-12).join('\n');
    fail('gitleaks', `found something in the history:\n${out}`);
  }
} else {
  skip('gitleaks', 'not installed (brew install gitleaks) — git history not scanned');
}

if (existsSync(join(ROOT, 'package-lock.json'))) {
  try {
    run('npm', ['audit', '--audit-level=high']);
  } catch (err) {
    fail('npm audit', `${err.stdout || err.message}`.trim().split('\n').slice(0, 12).join('\n'));
  }
} else {
  skip('npm audit', 'no lockfile, because the project has no dependencies');
}

if (have('semgrep')) {
  try {
    run('semgrep', ['--config', 'p/javascript', '--error', '--quiet', '--no-git-ignore', 'server', 'public', 'scripts']);
  } catch (err) {
    fail('semgrep', `${err.stdout || err.stderr || err.message}`.trim().split('\n').slice(0, 20).join('\n'));
  }
} else {
  skip('semgrep', 'not installed (brew install semgrep) — no third-party SAST run');
}

/* ---------- report ---------- */

for (const note of notes) console.log(`  skipped — ${note}`);

if (!problems.length) {
  console.log(`security: ${tracked.length} tracked files, ${SECRETS.length} secret patterns, 8 invariants — clean`);
  process.exit(0);
}

console.error('');
for (const p of problems) console.error(`${p.where}  ${p.message}`);
console.error(`\nsecurity: ${problems.length} problem(s)`);
process.exit(1);
