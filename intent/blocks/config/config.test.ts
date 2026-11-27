import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Unsafe, drift, envSecrets, inventory, load, redacted, type Setting } from './index.ts';

const DECL: Setting[] = [
  { name: 'PUBLIC_URL', kind: 'url', description: 'the address people use', required: true, usedBy: ['links', 'email'] },
  { name: 'WORKERS', kind: 'number', description: 'background workers', default: '2' },
  { name: 'DEBUG', kind: 'boolean', description: 'verbose errors', default: 'false', unsafeInProduction: (v) => (/^(true|1|yes|on)$/i.test(v) ? 'must be off in production' : null) },
  { name: 'SESSION_TTL', kind: 'duration', description: 'how long a session lasts', default: '12h' },
  { name: 'ADMINS', kind: 'list', description: 'admin emails', default: '' },
  { name: 'PAYMENTS_KEY', kind: 'text', description: 'payments API key', secret: true, required: true, rotateDays: 90, unsafeInProduction: (v) => (v.startsWith('sk_test_') ? 'is a test key' : null) },
];

test('settings are read and typed, secrets come from the secret source, and defaults apply', async () => {
  const v = await load(DECL, { PUBLIC_URL: 'https://files.example.org', WORKERS: '4' }, envSecrets({ PAYMENTS_KEY: 'sk_live_x' }), { production: true });
  assert.deepEqual(v, { PUBLIC_URL: 'https://files.example.org', WORKERS: 4, DEBUG: false, SESSION_TTL: 43_200_000, PAYMENTS_KEY: 'sk_live_x' });
  assert.equal(redacted(DECL, v)['PAYMENTS_KEY'], '[secret]');
});

test('the service refuses to start, listing every problem at once, and never echoes a secret', async () => {
  await assert.rejects(
    load(DECL, { PUBLIC_URL: 'ftp://x', WORKERS: 'many', DEBUG: 'yes', SESSION_TTL: 'soon' }, envSecrets({ PAYMENTS_KEY: 'sk_test_abc' }), { production: true }),
    (e: Unsafe) => {
      assert.equal(e.problems.length, 5);
      assert.ok(e.problems.some((p) => p.includes('DEBUG must be off in production')));
      assert.ok(e.problems.some((p) => p.includes('PAYMENTS_KEY is a test key')));
      assert.ok(!e.message.includes('sk_test_abc'));
      return true;
    },
  );
  await assert.rejects(load(DECL, {}, envSecrets({}), { production: false }), /PUBLIC_URL is required/);
});

test('the inventory names everything and each secret’s rotation, never a value', async () => {
  const v = await load(DECL, { PUBLIC_URL: 'https://a.org' }, envSecrets({ PAYMENTS_KEY: 'sk_live_x' }), { production: false });
  const inv = inventory(DECL, v, { PAYMENTS_KEY: '2026-07-01' }, new Date('2026-11-26'));
  const key = inv.find((x) => x.name === 'PAYMENTS_KEY')!;
  assert.equal(key.rotationDue, '2026-09-29');
  assert.equal(key.overdue, true);
  assert.ok(!JSON.stringify(inv).includes('sk_live_x'));
  assert.deepEqual(inv.find((x) => x.name === 'PUBLIC_URL')!.usedBy, ['links', 'email']);
});

test('drift lists every setting whose live value differs from what was signed', () => {
  assert.deepEqual(drift({ WORKERS: 2, DEBUG: false }, { WORKERS: 2, DEBUG: true, EXTRA: 'x' }), [
    { name: 'DEBUG', declared: false, live: true },
    { name: 'EXTRA', declared: undefined, live: 'x' },
  ]);
});
