import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ClientError, ClientRegistry, checkRedirectUri, matchRedirectUri, parseBasicAuthorization } from './index.ts';

/** Deterministic randomness: each call yields bytes counting up from a seed. */
function counter() {
  let n = 0;
  return (len: number) => {
    n += 1;
    return Uint8Array.from({ length: len }, (_, i) => (n * 31 + i) & 0xff);
  };
}
const make = (o: { t?: { v: number }; policy?: object } = {}) => {
  const t = o.t ?? { v: 1_800_000_000_000 };
  return { t, reg: new ClientRegistry({ now: () => t.v, randomBytes: counter(), registrationEndpoint: 'https://as.example.org/register', ...(o.policy ? { policy: o.policy } : {}) }) };
};
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof ClientError, String(e));
    return e.code;
  }
  assert.fail('expected a ClientError');
};

test('redirect URIs match exactly: no prefix, case, trailing-slash or query-parameter leniency', () => {
  const reg = ['https://app.example.org/cb', 'https://app.example.org/cb2?x=1'];
  assert.equal(matchRedirectUri(reg, 'https://app.example.org/cb'), true);
  assert.equal(matchRedirectUri(reg, 'https://app.example.org/cb/'), false);
  assert.equal(matchRedirectUri(reg, 'https://app.example.org/cb/evil'), false);
  assert.equal(matchRedirectUri(reg, 'https://APP.example.org/cb'), false);
  assert.equal(matchRedirectUri(reg, 'https://app.example.org/cb2'), false);
  assert.equal(matchRedirectUri(reg, 'https://app.example.org/cb2?x=1&y=2'), false);
  assert.equal(matchRedirectUri(reg, 'https://app.example.org.evil.test/cb'), false);
  assert.equal(matchRedirectUri(reg, 'https://app.example.org/cb#frag'), false);
  assert.equal(matchRedirectUri(reg, ''), false);
});

test('a native app on a loopback IP may use any port, but localhost, other hosts, paths and schemes may not', () => {
  const reg = ['http://127.0.0.1/callback', 'http://[::1]/cb'];
  assert.equal(matchRedirectUri(reg, 'http://127.0.0.1:53412/callback'), true);
  assert.equal(matchRedirectUri(reg, 'http://[::1]:8080/cb'), true);
  assert.equal(matchRedirectUri(reg, 'http://127.0.0.1:53412/other'), false);
  assert.equal(matchRedirectUri(reg, 'http://127.0.0.2:53412/callback'), false);
  assert.equal(matchRedirectUri(reg, 'http://localhost:53412/callback'), false);
  assert.equal(matchRedirectUri(reg, 'https://127.0.0.1:53412/callback'), false);
  assert.equal(matchRedirectUri(['https://a.example.org:8443/cb'], 'https://a.example.org:9000/cb'), false, 'the port is ignored only for loopback');
});

test('unsafe redirect URIs are refused when registering, each with its reason', () => {
  const bad: [string, RegExp][] = [
    ['https://a.example.org/cb#x', /fragment/],
    ['https://*.example.org/cb', /wildcard/],
    ['http://app.example.org/cb', /plain http/],
    ['javascript:alert(1)', /javascript/],
    ['data:text/html,x', /data/],
    ['/relative/path', /absolute/],
    ['https://user:pw@a.example.org/cb', /user name/],
    ['https://a.example.org/c b', /spaces/],
    ['', /non-empty/],
    [`https://a.example.org/${'a'.repeat(2100)}`, /2048/],
    ['myapp://cb', /reverse domain|native/],
  ];
  for (const [uri, why] of bad) assert.throws(() => checkRedirectUri(uri), (e: Error) => e instanceof ClientError && e.code === 'invalid_redirect_uri' && why.test(e.message), uri.slice(0, 40));
  assert.equal(checkRedirectUri('https://a.example.org/cb'), 'https://a.example.org/cb');
  assert.equal(checkRedirectUri('http://127.0.0.1:9/cb'), 'http://127.0.0.1:9/cb');
  assert.equal(checkRedirectUri('com.example.app:/oauth', 'native'), 'com.example.app:/oauth');
  assert.throws(() => checkRedirectUri('com.example.app:/oauth', 'web'), /native/);
  assert.throws(() => checkRedirectUri('http://localhost/cb'), /plain http/);
  assert.equal(checkRedirectUri('http://localhost/cb', 'web', { allowLocalhostHost: true }), 'http://localhost/cb');
});

test('dynamic registration returns RFC 7591 client information, with the secret once and only a hash kept', () => {
  const { reg, t } = make({ policy: { openRegistration: true } });
  const r = reg.register({
    client_name: 'Photos',
    redirect_uris: ['https://photos.example.org/cb'],
    scope: 'openid email',
    client_uri: 'https://photos.example.org',
  });
  assert.match(r.client_id, /^c_[A-Za-z0-9_-]+$/);
  assert.equal(r.client_id_issued_at, t.v / 1000);
  assert.equal(r.client_secret_expires_at, 0, '0 means the secret does not expire');
  assert.equal(r.token_endpoint_auth_method, 'client_secret_basic');
  assert.deepEqual(r.grant_types, ['authorization_code']);
  assert.deepEqual(r.response_types, ['code']);
  assert.equal(r.scope, 'openid email');
  assert.equal(r.registration_client_uri, `https://as.example.org/register/${r.client_id}`);
  assert.ok(r.client_secret && r.client_secret.length >= 43);
  const stored = JSON.stringify(reg.get(r.client_id));
  assert.ok(!stored.includes(r.client_secret!), 'the secret is not stored');
  assert.ok(!stored.includes(r.registration_access_token), 'neither is the registration token');
});

test('registration errors carry the RFC 7591 codes', () => {
  const { reg } = make({ policy: { openRegistration: true } });
  const ok = { redirect_uris: ['https://a.example.org/cb'] };
  assert.equal(code(() => reg.register({})), 'invalid_redirect_uri', 'authorization_code needs a redirect');
  assert.equal(code(() => reg.register({ redirect_uris: ['http://a.example.org/cb'] })), 'invalid_redirect_uri');
  assert.equal(code(() => reg.register({ ...ok, grant_types: ['password'] })), 'invalid_client_metadata');
  assert.equal(code(() => reg.register({ ...ok, grant_types: ['implicit'] })), 'invalid_client_metadata', 'implicit is not allowed by default');
  assert.equal(code(() => reg.register({ ...ok, response_types: ['token'] })), 'invalid_client_metadata');
  assert.equal(code(() => reg.register({ ...ok, token_endpoint_auth_method: 'client_secret_jwt' })), 'invalid_client_metadata');
  assert.equal(code(() => reg.register({ ...ok, scope: 'openid admin' })), 'invalid_client_metadata');
  assert.equal(code(() => reg.register({ ...ok, software_statement: 'eyJ...' })), 'invalid_software_statement');
  assert.equal(code(() => reg.register({ ...ok, client_id: 'mine' })), 'invalid_client_metadata', 'the server chooses the id');
  assert.equal(code(() => reg.register({ ...ok, logo_uri: 'http://a.example.org/l.png' })), 'invalid_client_metadata');
  assert.equal(code(() => reg.register({ ...ok, application_type: 'desktop' })), 'invalid_client_metadata');
  assert.equal(code(() => reg.register({ redirect_uris: [], grant_types: ['client_credentials'], token_endpoint_auth_method: 'none' })), 'invalid_client_metadata');
  assert.equal(code(() => reg.register([])), 'invalid_client_metadata');
  assert.deepEqual(new ClientError('invalid_redirect_uri', 'why').toJSON(), { error: 'invalid_redirect_uri', error_description: 'why' });
});

test('registration without an initial access token is refused unless the policy opens it', () => {
  const { reg } = make();
  assert.equal(code(() => reg.register({ redirect_uris: ['https://a.example.org/cb'] })), 'forbidden');
  const r = reg.register({ redirect_uris: ['https://a.example.org/cb'] }, true);
  assert.ok(reg.get(r.client_id));
});

test('a public client gets no secret, authenticates by being known, and is refused if it sends one', () => {
  const { reg } = make({ policy: { openRegistration: true } });
  const r = reg.register({ redirect_uris: ['com.example.app:/cb'], application_type: 'native', token_endpoint_auth_method: 'none' });
  assert.equal(r.client_secret, undefined);
  assert.equal(r.client_secret_expires_at, undefined);
  assert.equal(reg.authenticate({ clientId: r.client_id }).clientId, r.client_id);
  assert.equal(code(() => reg.authenticate({ clientId: r.client_id, clientSecret: 'guess' })), 'invalid_client');
  assert.equal(code(() => reg.rotateSecret(r.client_id, 0)), 'invalid_client_metadata');
});

test('confidential clients authenticate by the method they registered, and the wrong method is refused', () => {
  const { reg } = make();
  const { client, secret } = reg.create({ name: 'Basic app', redirectUris: ['https://a.example.org/cb'] });
  const header = `Basic ${Buffer.from(`${client.clientId}:${secret}`).toString('base64')}`;
  assert.equal(reg.authenticate({ authorization: header }).clientId, client.clientId);
  assert.equal(code(() => reg.authenticate({ clientId: client.clientId, clientSecret: secret })), 'invalid_client', 'body secret refused for a basic client');
  assert.equal(code(() => reg.authenticate({ authorization: header, clientSecret: secret })), 'invalid_client', 'two ways at once');
  assert.equal(code(() => reg.authenticate({ authorization: `Basic ${Buffer.from(`${client.clientId}:wrong`).toString('base64')}` })), 'invalid_client');
  assert.equal(code(() => reg.authenticate({ authorization: header, clientId: 'someone-else' })), 'invalid_client');
  assert.equal(code(() => reg.authenticate({ clientId: client.clientId })), 'invalid_client', 'no secret');
  assert.equal(code(() => reg.authenticate({ clientId: 'nobody', clientSecret: 'x' })), 'invalid_client');
  const post = reg.create({ name: 'Post app', redirectUris: ['https://b.example.org/cb'], authMethod: 'client_secret_post' });
  assert.equal(reg.authenticate({ clientId: post.client.clientId, clientSecret: post.secret }).name, 'Post app');
  assert.equal(code(() => reg.authenticate({ authorization: `Basic ${Buffer.from(`${post.client.clientId}:${post.secret}`).toString('base64')}` })), 'invalid_client');
});

test('every authentication failure gives the same message, so ids and secrets cannot be told apart', () => {
  const { reg } = make();
  const { client, secret } = reg.create({ name: 'A', redirectUris: ['https://a.example.org/cb'], authMethod: 'client_secret_post' });
  reg.disable(client.clientId);
  const messages = new Set<string>();
  for (const req of [{ clientId: 'nobody', clientSecret: 'x' }, { clientId: client.clientId, clientSecret: secret }, { clientId: client.clientId, clientSecret: 'bad' }]) {
    try {
      reg.authenticate(req);
    } catch (e) {
      messages.add((e as Error).message);
    }
  }
  assert.deepEqual([...messages], ['client authentication failed']);
  reg.disable(client.clientId, false);
  assert.equal(reg.authenticate({ clientId: client.clientId, clientSecret: secret }).clientId, client.clientId);
});

test('rotation keeps the old secret working for the overlap only, then the new one alone', () => {
  const { reg, t } = make();
  const { client, secret: old } = reg.create({ name: 'A', redirectUris: ['https://a.example.org/cb'], authMethod: 'client_secret_post' });
  const fresh = reg.rotateSecret(client.clientId, 60_000);
  assert.notEqual(fresh.secret, old);
  assert.equal(fresh.expiresAt, undefined);
  const as = (s: string) => reg.authenticate({ clientId: client.clientId, clientSecret: s }).clientId;
  assert.equal(as(old!), client.clientId);
  assert.equal(as(fresh.secret), client.clientId);
  t.v += 59_999;
  assert.equal(as(old!), client.clientId, 'still inside the overlap');
  t.v += 1;
  assert.equal(code(() => as(old!)), 'invalid_client', 'the overlap ended');
  assert.equal(as(fresh.secret), client.clientId);
  const again = reg.rotateSecret(client.clientId, 0);
  assert.equal(code(() => as(fresh.secret)), 'invalid_client', 'an overlap of zero ends the old secret at once');
  assert.equal(as(again.secret), client.clientId);
  assert.equal(reg.get(client.clientId)!.secrets.length, 1, 'ended secrets are dropped from the record');
});

test('a secret with a lifetime expires, is reported before it does, and revoking one leaves the other', () => {
  const { reg, t } = make({ policy: { secretTtlMs: 86_400_000 } });
  const { client, secret } = reg.create({ name: 'A', redirectUris: ['https://a.example.org/cb'], authMethod: 'client_secret_post' });
  assert.deepEqual(reg.expiring(1000), []);
  const soon = reg.expiring(86_400_000);
  assert.equal(soon.length, 1);
  assert.equal(soon[0]!.expiresAt, t.v + 86_400_000);
  t.v += 86_400_000;
  assert.equal(code(() => reg.authenticate({ clientId: client.clientId, clientSecret: secret })), 'invalid_client');
  const fresh = reg.rotateSecret(client.clientId, 10_000);
  const second = reg.rotateSecret(client.clientId, 10_000);
  const ids = reg.get(client.clientId)!.secrets.map((s) => s.id);
  reg.revokeSecret(client.clientId, ids[ids.length - 2]!);
  assert.equal(code(() => reg.authenticate({ clientId: client.clientId, clientSecret: fresh.secret })), 'invalid_client');
  assert.equal(reg.authenticate({ clientId: client.clientId, clientSecret: second.secret }).clientId, client.clientId);
  assert.equal(code(() => reg.revokeSecret(client.clientId, 'nope')), 'unknown_client');
});

test('resolving the redirect for an authorization request: exact, defaulted when only one, otherwise an error', () => {
  const { reg } = make();
  const one = reg.create({ name: 'One', redirectUris: ['https://a.example.org/cb'] }).client.clientId;
  const two = reg.create({ name: 'Two', redirectUris: ['https://a.example.org/cb', 'http://127.0.0.1/native'] }).client.clientId;
  assert.equal(reg.resolveRedirect(one, undefined), 'https://a.example.org/cb');
  assert.equal(reg.resolveRedirect(two, 'http://127.0.0.1:4444/native'), 'http://127.0.0.1:4444/native');
  assert.equal(code(() => reg.resolveRedirect(two, undefined)), 'invalid_redirect_uri');
  assert.equal(code(() => reg.resolveRedirect(one, 'https://evil.example.com/cb')), 'invalid_redirect_uri');
  assert.equal(code(() => reg.resolveRedirect('ghost', 'https://a.example.org/cb')), 'unknown_client');
  reg.disable(one);
  assert.equal(code(() => reg.resolveRedirect(one, 'https://a.example.org/cb')), 'invalid_client');
});

test('grants and scopes are limited to what the client registered', () => {
  const { reg } = make({ policy: { openRegistration: true } });
  const r = reg.register({ redirect_uris: ['https://a.example.org/cb'], grant_types: ['authorization_code', 'refresh_token'], scope: 'openid email' });
  assert.equal(reg.allowsGrant(r.client_id, 'refresh_token'), true);
  assert.equal(reg.allowsGrant(r.client_id, 'client_credentials'), false);
  assert.equal(reg.allowsGrant('ghost', 'refresh_token'), false);
  assert.deepEqual(reg.filterScopes(r.client_id, ['openid', 'profile', 'email']), { allowed: ['openid', 'email'], refused: ['profile'] });
  assert.equal(code(() => reg.register({ redirect_uris: ['https://a.example.org/cb'], grant_types: ['refresh_token'] })), 'invalid_client_metadata', 'refresh needs a grant that issues one');
});

test('RFC 7592 management needs the registration token and answers the same for a wrong id or a wrong token', () => {
  const { reg } = make({ policy: { openRegistration: true } });
  const r = reg.register({ client_name: 'Old', redirect_uris: ['https://a.example.org/cb'] });
  const read = reg.readRegistration(r.client_id, r.registration_access_token);
  assert.equal(read.client_name, 'Old');
  assert.equal('registration_access_token' in read, false);
  assert.equal(code(() => reg.readRegistration(r.client_id, 'wrong')), 'invalid_client');
  assert.equal(code(() => reg.readRegistration('ghost', r.registration_access_token)), 'invalid_client');
  assert.equal(code(() => reg.readRegistration(r.client_id, undefined)), 'invalid_client');
  const up = reg.updateRegistration(r.client_id, r.registration_access_token, { client_name: 'New', redirect_uris: ['https://a.example.org/cb2'] });
  assert.equal(up.client_name, 'New');
  assert.deepEqual(reg.get(r.client_id)!.redirectUris, ['https://a.example.org/cb2']);
  assert.equal(code(() => reg.updateRegistration(r.client_id, r.registration_access_token, { redirect_uris: ['http://evil.example.com/cb'] })), 'invalid_redirect_uri');
  assert.deepEqual(reg.get(r.client_id)!.redirectUris, ['https://a.example.org/cb2'], 'a refused update changes nothing');
  reg.deleteRegistration(r.client_id, r.registration_access_token);
  assert.equal(reg.get(r.client_id), undefined);
});

test('the Basic header is decoded the way RFC 6749 section 2.3.1 says, and garbage is not a credential', () => {
  const b = (s: string) => `Basic ${Buffer.from(s).toString('base64')}`;
  assert.deepEqual(parseBasicAuthorization(b('abc:def')), { clientId: 'abc', secret: 'def' });
  assert.deepEqual(parseBasicAuthorization(b('a%3Ab:p%20w+x')), { clientId: 'a:b', secret: 'p w x' });
  assert.deepEqual(parseBasicAuthorization(b('abc:de:f')), { clientId: 'abc', secret: 'de:f' });
  assert.equal(parseBasicAuthorization(b('nocolon')), undefined);
  assert.equal(parseBasicAuthorization('Bearer abc'), undefined);
  assert.equal(parseBasicAuthorization(b('a:%zz')), undefined);
  assert.equal(parseBasicAuthorization(undefined), undefined);
});

test('creating a client refuses duplicates, public client-credentials and a code client without a redirect', () => {
  const { reg } = make();
  reg.create({ name: 'A', clientId: 'first-party', redirectUris: ['https://a.example.org/cb'], trusted: true });
  assert.equal(reg.get('first-party')!.trusted, true);
  assert.equal(code(() => reg.create({ name: 'B', clientId: 'first-party', redirectUris: ['https://a.example.org/cb'] })), 'invalid_client_metadata');
  assert.equal(code(() => reg.create({ name: 'B' })), 'invalid_redirect_uri');
  assert.equal(code(() => reg.create({ name: 'B', authMethod: 'none', grantTypes: ['client_credentials'] })), 'invalid_client_metadata');
  assert.equal(reg.list().length, 1);
});
