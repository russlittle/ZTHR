import assert from 'node:assert/strict';
import { test } from 'node:test';
import { csrf, csrfToken, headers, nonce, sessionCookie } from './index.ts';

test('a page gets a strict policy, a nonce for its inline scripts, and every powerful feature off unless asked', () => {
  const n = nonce();
  const h = headers({ nonce: n, allow: { 'img-src': ['https://cdn.example.org'] }, features: ['camera'] });
  assert.match(h['content-security-policy']!, new RegExp(`script-src 'self' 'nonce-${n.replace(/[+/]/g, '\\$&')}'`));
  assert.match(h['content-security-policy']!, /img-src 'self' data: https:\/\/cdn\.example\.org/);
  assert.match(h['content-security-policy']!, /frame-ancestors 'none'/);
  assert.match(h['content-security-policy']!, /object-src 'none'/);
  assert.ok(!h['content-security-policy']!.includes('unsafe-inline'));
  assert.match(h['permissions-policy']!, /camera=\(self\)/);
  assert.match(h['permissions-policy']!, /microphone=\(\)/);
  assert.equal(h['x-frame-options'], 'DENY');
  assert.equal(headers({ api: true })['content-security-policy'], "default-src 'none'; frame-ancestors 'none'");
  assert.match(sessionCookie('s', 'v', 60), /^__Host-s=v; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=60$/);
});

test('a change must come from this site and carry its session’s token; reads always pass', () => {
  const site = ['https://files.example.org'];
  const token = csrfToken('secret', 'sess-1');
  assert.equal(csrf({ method: 'GET' }, 'secret', site), null);
  assert.equal(csrf({ method: 'POST', origin: 'https://files.example.org', token, sessionId: 'sess-1' }, 'secret', site), null);
  assert.equal(csrf({ method: 'POST', referer: 'https://files.example.org/apps/files?dir=/', token, sessionId: 'sess-1' }, 'secret', site), null);
  assert.match(csrf({ method: 'POST', origin: 'https://evil.example', token, sessionId: 'sess-1' }, 'secret', site)!, /did not come from this site/);
  assert.match(csrf({ method: 'DELETE', origin: 'https://files.example.org', sessionId: 'sess-1' }, 'secret', site)!, /no request token/);
  assert.match(csrf({ method: 'POST', origin: 'https://files.example.org', token, sessionId: 'sess-2' }, 'secret', site)!, /does not match/);
  assert.notEqual(csrfToken('secret', 'a'), csrfToken('secret', 'b'));
});

test('a cookie name or value cannot add attributes, and a nonce or source cannot add directives', () => {
  assert.throws(() => sessionCookie('s', 'v; Domain=evil.example', 60), /cookie/);
  assert.throws(() => sessionCookie('s; Path=/x', 'v', 60), /cookie/);
  assert.throws(() => sessionCookie('s', 'v\r\nSet-Cookie: x=1', 60), /cookie/);
  assert.throws(() => sessionCookie('s', 'v', Number.NaN), /cookie/);
  assert.throws(() => headers({ nonce: "abc' 'unsafe-inline" }), /nonce/);
  assert.throws(() => headers({ allow: { 'script-src': ["https://cdn.example.org; script-src 'unsafe-inline'"] } }), /source/);
  assert.throws(() => headers({ allow: { 'frame-src': ['https://a.example.org,https://b'] } }), /source/);
  assert.doesNotThrow(() => headers({ allow: { 'img-src': ['https://*.example.org', "'self'", 'blob:'] } }));
});

test('the default page policy and every companion header are exact, with every powerful feature off', () => {
  const h = headers();
  assert.deepEqual(h, {
    'content-security-policy': [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "font-src 'self'",
      "frame-src 'none'",
      "media-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      'upgrade-insecure-requests',
    ].join('; '),
    'strict-transport-security': 'max-age=31536000; includeSubDomains',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'permissions-policy': [
      'camera=()',
      'microphone=()',
      'geolocation=()',
      'payment=()',
      'usb=()',
      'serial=()',
      'bluetooth=()',
      'display-capture=()',
      'fullscreen=()',
      'publickey-credentials-get=()',
    ].join(', '),
  });
});

test('each named feature can be switched on by itself and no other', () => {
  for (const f of ['camera', 'microphone', 'geolocation', 'payment', 'usb', 'serial', 'bluetooth', 'display-capture', 'fullscreen', 'publickey-credentials-get']) {
    const policy = headers({ features: [f] })['permissions-policy']!;
    assert.equal(policy.split(', ').filter((p) => p.endsWith('=(self)')).join(), `${f}=(self)`);
    assert.equal(policy.split(', ').length, 10);
  }
});

test('extra sources are added to their own directive only, space separated, and a nonce goes in the script directive', () => {
  const csp = headers({
    nonce: 'abc123==',
    allow: {
      'script-src': ['https://a.example', 'https://b.example'],
      'style-src': ['https://s.example', 'https://t.example'],
      'img-src': ['https://i.example', 'https://j.example'],
      'connect-src': ['https://c.example', 'https://d.example'],
      'font-src': ['https://f.example', 'https://g.example'],
      'frame-src': ['https://x.example', 'https://y.example'],
      'media-src': ['https://m.example', 'https://n.example'],
    },
  })['content-security-policy']!;
  assert.deepEqual(csp.split('; '), [
    "default-src 'self'",
    "script-src 'self' 'nonce-abc123==' https://a.example https://b.example",
    "style-src 'self' https://s.example https://t.example",
    "img-src 'self' data: https://i.example https://j.example",
    "connect-src 'self' https://c.example https://d.example",
    "font-src 'self' https://f.example https://g.example",
    'frame-src https://x.example https://y.example',
    "media-src 'self' https://m.example https://n.example",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    'upgrade-insecure-requests',
  ]);
});

test('a directive left undefined in the allow list is treated as empty, and an empty allow list changes nothing', () => {
  const plain = headers()['content-security-policy'];
  assert.equal(headers({ allow: { 'img-src': undefined } as never })['content-security-policy'], plain);
  assert.equal(headers({ allow: {} })['content-security-policy'], plain);
});

test('strict transport security lasts the number of days asked, in seconds, and a year by default', () => {
  assert.equal(headers({ hstsDays: 30 })['strict-transport-security'], 'max-age=2592000; includeSubDomains');
  assert.equal(headers({ hstsDays: 1 })['strict-transport-security'], 'max-age=86400; includeSubDomains');
  assert.equal(headers({ hstsDays: 0 })['strict-transport-security'], 'max-age=0; includeSubDomains');
  assert.equal(headers({})['strict-transport-security'], 'max-age=31536000; includeSubDomains');
});

test('cookie names and values of several characters are accepted, an empty value is allowed, an empty name is not', () => {
  assert.equal(sessionCookie('session-id_1', 'abcDEF123-_.~', 3600), '__Host-session-id_1=abcDEF123-_.~; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=3600');
  assert.equal(sessionCookie('s', '', 0), '__Host-s=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
  assert.throws(() => sessionCookie('', 'v', 60), /cookie/);
});

test('a request token is URL-safe base64 of a SHA-256 digest, stable for a session, and safe methods need nothing', () => {
  const t = csrfToken('secret', 'sess-1');
  assert.match(t, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(t, csrfToken('secret', 'sess-1'));
  assert.notEqual(t, csrfToken('other', 'sess-1'));
  for (const method of ['GET', 'HEAD', 'OPTIONS', 'get', 'head', 'options']) assert.equal(csrf({ method }, 'secret', ['https://a.example']), null);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.notEqual(csrf({ method }, 'secret', ['https://a.example']), null);
});

test('a token of the wrong length is refused as a mismatch rather than failing', () => {
  const site = ['https://files.example.org'];
  const good = csrfToken('secret', 'sess-1');
  for (const token of ['x', good.slice(0, -1), `${good}x`]) {
    assert.equal(csrf({ method: 'POST', origin: 'https://files.example.org', token, sessionId: 'sess-1' }, 'secret', site), 'the request token does not match this session');
  }
});

test('a malformed referer is no origin at all', () => {
  assert.equal(csrf({ method: 'POST', referer: 'not a url', token: 'x', sessionId: 's' }, 'secret', ['https://a.example']), 'the request did not come from this site');
});
