// Verifies docs/blocks/egress.md
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EgressRefused, EgressTwin, allowed, realEgress, routedEgress } from '../src/index.js';

afterEach(() => vi.unstubAllGlobals());

describe('allow-list edges', () => {
  it('a wildcard needs at least one label before the domain', () => {
    expect(allowed('x.example.com', ['*.example.com'])).toBe(true);
    expect(allowed('.example.com', ['*.example.com'])).toBe(false);
    expect(allowed('a.b.example.com', ['*.example.com'])).toBe(true);
    expect(allowed('example.com', [])).toBe(false);
    expect(allowed('b.io', ['a.io', 'b.io'])).toBe(true);
  });
});

describe('the real door', () => {
  it('sends to an allowed host with the request as given, never following redirects, and records it', async () => {
    const calls: [string, RequestInit][] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => (calls.push([url, init]), new Response('hello', { status: 201 })));
    const e = realEgress(['API.example.com'.toLowerCase()]);
    const r = await e.send({ purpose: 'p', method: 'POST', url: 'https://API.example.com/x', body: 'b', headers: { h: '1' } });
    expect(r).toEqual({ status: 201, body: 'hello' });
    expect(calls[0]![0]).toBe('https://API.example.com/x');
    expect(calls[0]![1]).toMatchObject({ method: 'POST', body: 'b', headers: { h: '1' }, redirect: 'error' });
    expect(calls[0]![1].signal).toBeInstanceOf(AbortSignal);
    expect(e.log).toHaveLength(1);
    expect(e.log[0]).toMatchObject({ purpose: 'p', method: 'POST', host: 'api.example.com', status: 201 });
    expect(Date.parse(e.log[0]!.at)).not.toBeNaN();
  });
  it('gives up after its timeout', async () => {
    vi.stubGlobal('fetch', (_u: string, init: RequestInit) => new Promise((_r, rej) => init.signal!.addEventListener('abort', () => rej(new Error('aborted')))));
    const t = Date.now();
    await expect(realEgress(['a.io'], 50).send({ purpose: 'p', method: 'GET', url: 'https://a.io/' })).rejects.toThrow('aborted');
    expect(Date.now() - t).toBeLessThan(1000);
  });
  it('a refused request never reaches fetch', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    await expect(realEgress(['a.io']).send({ purpose: 'p', method: 'GET', url: 'https://b.io/' })).rejects.toThrow('b.io is not on the egress allow-list');
    await expect(realEgress(['a.io']).send({ purpose: 'p', method: 'GET', url: 'http://a.io/' })).rejects.toThrow('only https is allowed: http:');
    expect(f).not.toHaveBeenCalled();
  });
});

describe('the twin', () => {
  it('allows everything by default and answers 200 with an empty object', async () => {
    const t = new EgressTwin();
    expect(await t.send({ purpose: 'p', method: 'GET', url: 'https://any.io/' })).toEqual({ status: 200, body: '{}' });
    expect(t.log[0]).toMatchObject({ purpose: 'p', method: 'GET', host: 'any.io', status: 200 });
  });
  it('records a refusal and sends nothing', async () => {
    const t = new EgressTwin(['a.io']);
    await expect(t.send({ purpose: 'p', method: 'GET', url: 'https://b.io/' })).rejects.toThrow('b.io is not on the egress allow-list');
    expect(t.sent).toEqual([]);
    expect(t.log[0]).toMatchObject({ host: 'b.io', status: 'refused', method: 'GET', purpose: 'p' });
  });
});

describe('the routed door', () => {
  const svc = { fetch: async (r: Request) => new Response(JSON.stringify({ m: r.method, u: r.url, h: r.headers.get('x-a'), k: r.headers.get('x-k'), b: r.method === 'POST' ? await r.text() : null }), { status: 202 }) };
  it('runs a mapped host in process, with default headers under the request\'s own', async () => {
    const e = routedEgress({ 'svc.local': svc }, undefined, () => ({ 'x-a': 'default', 'x-k': 'default' }));
    const r = await e.send({ purpose: 'p', method: 'POST', url: 'https://svc.local/x?y=1', body: 'hi', headers: { 'x-k': 'mine' } });
    expect(r.status).toBe(202);
    expect(JSON.parse(r.body)).toEqual({ m: 'POST', u: 'https://svc.local/x?y=1', h: 'default', k: 'mine', b: 'hi' });
    expect(e.log[0]).toMatchObject({ purpose: 'p', method: 'POST', host: 'svc.local', status: 202 });
  });
  it('refuses an unmapped host with no fallback, and uses the fallback when given', async () => {
    const e = routedEgress({ 'svc.local': svc });
    await expect(e.send({ purpose: 'p', method: 'GET', url: 'https://other.io/' })).rejects.toBeInstanceOf(EgressRefused);
    expect(e.log[0]).toMatchObject({ host: 'other.io', status: 'refused' });
    const twin = new EgressTwin(['*'], () => ({ status: 204, body: '' }));
    const f = routedEgress({ 'svc.local': svc }, twin);
    expect((await f.send({ purpose: 'q', method: 'GET', url: 'https://other.io/' })).status).toBe(204);
    expect(f.log[0]).toMatchObject({ host: 'other.io', status: 204, purpose: 'q' });
  });
});
