// The debugging endpoint is a security control: whatever Chrome's HTTP
// interface reports, the socket only ever opens on our own loopback port.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { devtoolsEndpoint } from '../../server/chrome.mjs';

test('keeps the target out of the address and rebuilds it', () => {
  assert.equal(
    devtoolsEndpoint('ws://127.0.0.1:9222/devtools/page/A1B2C3', 9222),
    'ws://127.0.0.1:9222/devtools/page/A1B2C3',
  );
  assert.equal(
    devtoolsEndpoint('ws://localhost:9333/devtools/browser/4f2e-11aa', 9333),
    'ws://127.0.0.1:9333/devtools/browser/4f2e-11aa',
    'the host it reported is replaced by ours',
  );
});

test('a reported address never moves the connection elsewhere', () => {
  const elsewhere = [
    'ws://evil.example.com:9222/devtools/page/A1',
    'wss://evil.example.com/devtools/page/A1',
    'http://127.0.0.1:9222/devtools/page/A1',
  ];
  for (const url of elsewhere) {
    assert.equal(devtoolsEndpoint(url, 9222), 'ws://127.0.0.1:9222/devtools/page/A1',
      `${url} should come back pointing at us`);
  }
});

test('a path that is not a devtools target is refused', () => {
  const bad = [
    'ws://127.0.0.1:9222/',
    'ws://127.0.0.1:9222/devtools/page/',
    'ws://127.0.0.1:9222/devtools/inspector/A1',
    'ws://127.0.0.1:9222/devtools/page/A1/../../elsewhere',
    'ws://127.0.0.1:9222/devtools/page/' + 'x'.repeat(200),
  ];
  for (const url of bad) {
    assert.throws(() => devtoolsEndpoint(url, 9222), /does not recognise/, url);
  }
});

test('something that is not a URL at all is refused', () => {
  assert.throws(() => devtoolsEndpoint('not a url', 9222), /not a URL/);
  assert.throws(() => devtoolsEndpoint('', 9222), /not a URL/);
});
