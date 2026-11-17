// The linter for a project with no dependencies.
//
// Two passes: every JavaScript file must parse (node --check does that for the
// module itself, but not for the code we inject into the page as strings), and
// every file is checked against the handful of rules this codebase actually
// cares about. No style policing — only things that would be a bug or a leak.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { parseError } from './parses.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SKIP_DIRS = new Set(['node_modules', 'data', '.git', '.idea']);

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const problems = [];
const flag = (file, line, rule, message) =>
  problems.push({ file: relative(ROOT, file), line, rule, message });

const RULES = [
  {
    name: 'no-debugger',
    // Trim first: a pattern ending in \s*;?\s*$ backtracks on a long line.
    test: (l) => /(^|[^\w.])debugger;?$/.test(l.trimEnd()),
    message: 'debugger statement left in',
  },
  {
    name: 'no-focused-test',
    test: (l) => /\b(it|test|describe)\.only\s*\(/.test(l),
    message: 'focused test would hide the rest of the suite',
  },
  {
    name: 'no-skipped-test',
    test: (l) => /\b(it|test|describe)\.skip\s*\(/.test(l),
    message: 'skipped test — delete it or fix it',
  },
  {
    name: 'no-hardcoded-key',
    test: (l) => /SWIPE_KEY\s*[=:]\s*['"][a-z0-9]{6,}['"]/i.test(l),
    message: 'access key hardcoded',
  },
  {
    name: 'no-cookie-logging',
    test: (l) => /console\.(log|info|warn|error)\([^)]*\bli_at\b/.test(l),
    message: 'never print the session cookie',
  },
  {
    name: 'no-trailing-whitespace',
    // One character is enough to know, and it cannot backtrack.
    test: (l) => /[ \t]$/.test(l),
    message: 'trailing whitespace',
  },
];

const files = walk(ROOT).filter((f) => ['.mjs', '.js'].includes(extname(f)));
if (!files.length) {
  console.error('lint: no JavaScript found — is this the right directory?');
  process.exit(1);
}

for (const file of files) {
  // 1. It has to parse.
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (err) {
    flag(file, 0, 'syntax', String(err.stderr || err.message).split('\n').slice(0, 3).join(' ').trim());
    continue;
  }

  // 2. And it has to keep to the house rules.
  const text = readFileSync(file, 'utf8');
  text.split('\n').forEach((line, i) => {
    for (const rule of RULES) if (rule.test(line)) flag(file, i + 1, rule.name, rule.message);
  });
  if (text.length && !text.endsWith('\n')) flag(file, text.split('\n').length, 'final-newline', 'no newline at end of file');
}

// 3. The snippets we evaluate inside the LinkedIn page are strings, so no
//    parser has seen them yet. Compile each as the async body it will become.
const { pageSnippets } = await import(new URL('../server/linkedin.mjs', import.meta.url));
for (const [name, snippet] of Object.entries(pageSnippets)) {
  const source = typeof snippet === 'function' ? snippet('probe-slug') : snippet;
  const error = parseError(source);
  if (error) flag(join(ROOT, 'server/linkedin.mjs'), 0, 'page-snippet', `${name}: ${error}`);
}

if (!problems.length) {
  console.log(`lint: ${files.length} files, ${Object.keys(pageSnippets).length} page snippets — clean`);
  process.exit(0);
}

for (const p of problems) console.error(`${p.file}:${p.line}  ${p.rule}  ${p.message}`);
console.error(`\nlint: ${problems.length} problem(s)`);
process.exit(1);
