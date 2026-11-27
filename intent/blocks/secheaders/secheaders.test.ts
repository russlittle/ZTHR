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
