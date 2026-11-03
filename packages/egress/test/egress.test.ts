// Verifies docs/blocks/egress.md (one door to the network, allow-listed and recorded).
import { describe, expect, it } from 'vitest';
import { EgressRefused, EgressTwin, allowed, realEgress } from '../src/index.js';

describe('egress', () => {
  it.each([
    ['hooks.example.com', ['hooks.example.com'], true],
    ['a.example.com', ['*.example.com'], true],
    ['example.com', ['*.example.com'], false],
    ['evil-example.com', ['*.example.com'], false],
    ['example.com.evil.io', ['example.com'], false],
    ['www.googleapis.com', ['www.googleapis.com', 'oauth2.googleapis.com'], true],
  ])('allow-list: %s against %j is %s', (host, list, ok) => expect(allowed(host, list as string[])).toBe(ok));

  it('refuses plain http before any request', async () => {
    await expect(realEgress(['example.com']).send({ purpose: 't', method: 'GET', url: 'http://example.com' })).rejects.toBeInstanceOf(EgressRefused);
  });
  it('refuses and records a host off the list without a request', async () => {
    const e = realEgress(['example.com']);
    await expect(e.send({ purpose: 'webhook', method: 'POST', url: 'https://attacker.io/x' })).rejects.toThrow(/allow-list/);
    expect(e.log[0]).toMatchObject({ host: 'attacker.io', status: 'refused', purpose: 'webhook' });
  });
  it('twin records what would have been sent', async () => {
    const t = new EgressTwin(['hooks.example.com'], () => ({ status: 202, body: 'ok' }));
    const r = await t.send({ purpose: 'webhook', method: 'POST', url: 'https://hooks.example.com/a', body: '{"x":1}' });
    expect(r.status).toBe(202);
    expect(t.sent).toHaveLength(1);
    await expect(t.send({ purpose: 'webhook', method: 'POST', url: 'https://other.io' })).rejects.toBeInstanceOf(EgressRefused);
  });
});
