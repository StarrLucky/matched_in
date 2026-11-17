// Does a piece of source parse?
//
// The snippets this project injects into the LinkedIn page live in template
// strings, so no parser sees them until something checks. That check used to be
// `new Function(src)`, which compiles the text into a callable — a thing worth
// avoiding in a tool whose whole job is handling text scraped off a web page.
// A parser is asked instead, in a process of its own, and nothing is ever
// callable here.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Null when it parses, otherwise the parser's complaint. */
export function parseError(source) {
  const dir = mkdtempSync(join(tmpdir(), 'matched-in-parse-'));
  const file = join(dir, 'snippet.mjs');
  try {
    writeFileSync(file, `export default async () => { ${source} };\n`);
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    return null;
  } catch (err) {
    return String(err.stderr || err.message).split('\n').slice(0, 3).join(' ').trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
