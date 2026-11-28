import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Directory, LdapError, RC, parseDn, normalizeDn, dnEquals, escapeDnValue, formatDn, parentDn, isUnder, parseFilter, formatFilter, escapeFilterValue, filterTemplate, hashPassword, verifyPassword, mapEntry, MappingError, resolveGroups, planUserSync, SyncRefused } from './index.ts';

const mk = (o: Partial<ConstructorParameters<typeof Directory>[0]> = {}) => {
  const d = new Directory({ suffixes: ['dc=ex,dc=com'], ...o });
  d.add('dc=ex,dc=com', { objectClass: 'domain', dc: 'ex' });
  d.add('ou=people,dc=ex,dc=com', { objectClass: 'organizationalUnit', ou: 'people' });
  d.add('ou=groups,dc=ex,dc=com', { objectClass: 'organizationalUnit', ou: 'groups' });
  return d;
};
const person = (d: Directory, uid: string, extra: Record<string, string | string[]> = {}) =>
  d.add(`uid=${uid},ou=people,dc=ex,dc=com`, { objectClass: ['inetOrgPerson', 'person'], uid, cn: uid.toUpperCase(), sn: 'S', mail: `${uid}@ex.com`, ...extra });

test('DN parsing: escapes, hex pairs, multi-valued, errors', () => {
  const r = parseDn('CN=Smith\\, John+uid=js,OU=A\\2BB,dc=ex');
  assert.equal(r.length, 3);
  assert.deepEqual(r[0]!.map((a) => a.value), ['Smith, John', 'js']);
  assert.equal(r[1]![0]!.value, 'A+B');
  assert.deepEqual(parseDn(''), []);
  assert.equal(parseDn('cn=\\C3\\A9')[0]![0]!.value, 'é');
  assert.equal(parseDn('cn=#0402AB')[0]![0]!.hex, true);
  for (const b of ['cn', 'cn=a,', 'cn=a<b', '=a', 'cn=\\zz', 'cn=\\C3', 'cn=#abc']) assert.throws(() => parseDn(b), (e: unknown) => e instanceof LdapError && e.code === RC.invalidDNSyntax, b);
  assert.throws(() => parseDn('cn=' + 'a'.repeat(3000)));
});

test('DN normalisation and comparison', () => {
  assert.ok(dnEquals('CN=Ana  Lee, OU=People ,DC=Ex', 'cn=ana lee,ou=people,dc=ex'));
  assert.ok(dnEquals('cn=a+uid=b,dc=x', 'uid=B+cn=A,dc=x'));
  assert.ok(!dnEquals('cn=a,dc=x', 'cn=a,dc=y'));
  assert.equal(parentDn('cn=a,ou=b,dc=c'), 'ou=b,dc=c');
  assert.equal(parentDn('dc=c'), null);
});

test('isUnder compares parts, not text', () => {
  assert.ok(isUnder('uid=a,ou=people,dc=ex', 'ou=people,dc=ex'));
  assert.ok(!isUnder('ou=people,dc=ex', 'ou=people,dc=ex', false));
  assert.ok(!isUnder('uid=a,ou=xpeople,dc=ex', 'ou=people,dc=ex'));
  assert.ok(!isUnder('uid=a\\,ou=people,dc=ex', 'ou=people,dc=ex'));
  assert.ok(isUnder('dc=ex', ''));
});

test('escaping a name for a DN cannot change its shape', () => {
  const evil = 'x,ou=admins,dc=ex';
  const dn = `cn=${escapeDnValue(evil)},ou=people,dc=ex`;
  const r = parseDn(dn);
  assert.equal(r.length, 3);
  assert.equal(r[0]![0]!.value, evil);
  for (const v of [' lead', 'trail ', '#hash', 'a+b', 'q"uote', 'back\\slash', 'nul\u0000']) assert.equal(parseDn(`cn=${escapeDnValue(v)}`)[0]![0]!.value, v);
  assert.equal(formatDn(parseDn(dn)), dn);
});

test('filter parsing: RFC 4515 examples', () => {
  assert.deepEqual(parseFilter('(cn=Babs Jensen)'), { op: 'eq', attr: 'cn', value: 'Babs Jensen' });
  assert.equal(parseFilter('(!(cn=Tim Howes))').op, 'not');
  const f = parseFilter('(&(objectClass=Person)(|(sn=Jensen)(cn=Babs J*)))');
  assert.equal(f.op, 'and');
  assert.deepEqual(parseFilter('(o=univ*of*mich*)'), { op: 'substr', attr: 'o', initial: 'univ', any: ['of', 'mich'] });
  assert.deepEqual(parseFilter('(seeAlso=*)'), { op: 'present', attr: 'seeAlso' });
  assert.equal(parseFilter('(cn=Lu\\c4\\8di\\c4\\87)').op, 'eq');
  assert.equal((parseFilter('(cn=Lu\\c4\\8di\\c4\\87)') as { value: string }).value, 'Lučić');
  assert.deepEqual(parseFilter('(1.3.6.1.4.1.1466.0=\\04\\02\\48\\69)'), { op: 'eq', attr: '1.3.6.1.4.1.1466.0', value: '\u0004\u0002Hi' });
  const e = parseFilter('(o:dn:=Ace Industry)');
  assert.deepEqual(e, { op: 'ext', attr: 'o', dn: true, value: 'Ace Industry' });
  assert.deepEqual(parseFilter('(:1.2.3:=Wally)'), { op: 'ext', rule: '1.2.3', dn: false, value: 'Wally' });
});

test('malformed and hostile filters are refused', () => {
  for (const b of ['', 'cn=a', '(cn=a', '(cn=a))', '(&)', '(cn=a(b))', '(cn=\\zz)', '(cn>=a*)', '(=a)', '(cn=a)(cn=b)', '(cn=\\c3)'])
    assert.throws(() => parseFilter(b), (e: unknown) => e instanceof LdapError && e.code === RC.protocolError, b);
  assert.throws(() => parseFilter('(&'.repeat(30) + '(a=b)' + ')'.repeat(30)), /deep/);
  assert.throws(() => parseFilter('(|' + '(a=b)'.repeat(300) + ')'), /conditions/);
  assert.throws(() => parseFilter('(cn=' + 'a'.repeat(5000) + ')'), /longer/);
});

test('filter injection is stopped by escaping', () => {
  const evil = 'x)(uid=*))(|(uid=*';
  const f = filterTemplate`(&(objectClass=person)(uid=${evil}))`;
  const p = parseFilter(f);
  assert.equal(p.op, 'and');
  assert.equal(((p as unknown as { items: { value?: string }[] }).items[1]!.value), evil);
  assert.equal(escapeFilterValue('a*b(c)\\'), 'a\\2ab\\28c\\29\\5c');
  assert.equal(formatFilter(parseFilter(f)), f);
  for (const s of ['(&(a=1)(|(b=*x*y)(!(c>=3))))', '(cn:dn:2.5.13.5:=a\\2ab)']) assert.equal(formatFilter(parseFilter(s)), s);
});

test('evaluation: operators and case/space folding', () => {
  const d = mk();
  person(d, 'ana', { age: '30', cn: 'Ana  Lee', title: ['Dev', 'Lead'] });
  person(d, 'bob', { age: '9' });
  const q = (f: string) => d.search('dc=ex,dc=com', f).entries.map((e) => e.dn.split(',')[0]);
  assert.deepEqual(q('(cn=ana lee)'), ['uid=ana']);
  assert.deepEqual(q('(&(objectClass=inetOrgPerson)(age>=10))'), ['uid=ana']);
  assert.deepEqual(q('(age<=9)'), ['uid=bob']);
  assert.deepEqual(q('(mail=*@ex.com)').sort(), ['uid=ana', 'uid=bob']);
  assert.deepEqual(q('(mail=a*a@*m)'), ['uid=ana']);
  assert.deepEqual(q('(title=lead)'), ['uid=ana']);
  assert.deepEqual(q('(cn~=analee)'), ['uid=ana']);
  assert.deepEqual(q('(&(uid=*)(!(uid=ana)))'), ['uid=bob']);
  assert.deepEqual(q('(title=*)'), ['uid=ana']);
});

test('unknown attributes are Undefined: no match and not negatable', () => {
  const d = mk({ knownAttributes: ['uid', 'cn', 'mail', 'objectClass', 'ou', 'dc', 'sn'] });
  person(d, 'ana');
  assert.equal(d.search('dc=ex,dc=com', '(bogus=1)').entries.length, 0);
  assert.equal(d.search('dc=ex,dc=com', '(!(bogus=1))').entries.length, 0);
  assert.equal(d.search('dc=ex,dc=com', '(|(bogus=1)(uid=ana))').entries.length, 1);
  assert.equal(d.search('dc=ex,dc=com', '(!(uid=zed))').entries.length > 0, true);
});

test('scopes, missing base, attribute selection, no passwords returned', () => {
  const d = mk();
  person(d, 'ana', { userPassword: hashPassword('SSHA', 'pw') });
  assert.equal(d.search('ou=people,dc=ex,dc=com', '(objectClass=*)', { scope: 'base' }).entries.length, 1);
  assert.equal(d.search('dc=ex,dc=com', '(objectClass=*)', { scope: 'one' }).entries.length, 2);
  assert.equal(d.search('dc=ex,dc=com', '(objectClass=*)').entries.length, 4);
  assert.throws(() => d.search('ou=nope,dc=ex,dc=com', '(a=b)'), (e: unknown) => (e as LdapError).code === RC.noSuchObject);
  const e = d.search('dc=ex,dc=com', '(uid=ana)', { attrs: ['mail'] }).entries[0]!;
  assert.deepEqual(Object.keys(e.attrs), ['mail']);
  const all = d.search('dc=ex,dc=com', '(uid=ana)').entries[0]!;
  assert.equal(Object.keys(all.attrs).some((k) => k.toLowerCase() === 'userpassword'), false);
  assert.deepEqual(d.search('dc=ex,dc=com', '(uid=ana)', { attrs: ['1.1'] }).entries[0]!.attrs, {});
  assert.equal(d.search('dc=ex,dc=com', '(userPassword=*)').entries.length, 1);
});

test('size limit and paged results with a cookie bound to the query', () => {
  const d = mk();
  for (let i = 0; i < 25; i++) person(d, `u${String(i).padStart(2, '0')}`);
  const lim = d.search('dc=ex,dc=com', '(uid=*)', { sizeLimit: 10 });
  assert.equal(lim.code, RC.sizeLimitExceeded);
  assert.equal(lim.entries.length, 10);
  const seen: string[] = [];
  let cookie: string | undefined;
  let pages = 0;
  do {
    const r = d.search('dc=ex,dc=com', '(uid=*)', { pageSize: 10, ...(cookie ? { cookie } : {}) });
    seen.push(...r.entries.map((e) => e.dn));
    cookie = r.cookie;
    pages++;
  } while (cookie);
  assert.equal(pages, 3);
  assert.equal(new Set(seen).size, 25);
  const first = d.search('dc=ex,dc=com', '(uid=*)', { pageSize: 10 });
  assert.throws(() => d.search('dc=ex,dc=com', '(uid=u0*)', { pageSize: 10, cookie: first.cookie! }), /different search/);
  assert.throws(() => d.search('dc=ex,dc=com', '(uid=*)', { pageSize: 10, cookie: 'garbage' }), /cookie/);
  assert.equal(d.searchAll('dc=ex,dc=com', '(uid=*)', { pageSize: 7 }).length, 25);
  assert.throws(() => d.searchAll('dc=ex,dc=com', '(uid=*)', { pageSize: 7, maxEntries: 10 }), (e: unknown) => (e as LdapError).code === RC.sizeLimitExceeded);
});

test('add, modify, delete rules', () => {
  const d = mk();
  assert.throws(() => d.add('ou=people,dc=ex,dc=com', { objectClass: 'x' }), (e: unknown) => (e as LdapError).code === RC.entryAlreadyExists);
  assert.throws(() => d.add('uid=a,ou=nope,dc=ex,dc=com', { objectClass: 'x' }), (e: unknown) => (e as LdapError).code === RC.noSuchObject);
  assert.throws(() => d.add('uid=a,ou=people,dc=ex,dc=com', { uid: 'a' }), /objectClass/);
  person(d, 'ana');
  d.modify('uid=ana,ou=people,dc=ex,dc=com', [{ op: 'add', attr: 'mail', values: ['b@ex.com'] }, { op: 'replace', attr: 'sn', values: ['New'] }, { op: 'delete', attr: 'cn' }]);
  const e = d.get('UID=Ana,ou=people,dc=ex,dc=com')!;
  assert.deepEqual(e.attrs.mail, ['ana@ex.com', 'b@ex.com']);
  assert.deepEqual(e.attrs.sn, ['New']);
  assert.equal(e.attrs.cn, undefined);
  assert.throws(() => d.modify('uid=ana,ou=people,dc=ex,dc=com', [{ op: 'delete', attr: 'nothing' }]), (x: unknown) => (x as LdapError).code === RC.noSuchAttribute);
  assert.throws(() => d.delete('ou=people,dc=ex,dc=com'), (x: unknown) => (x as LdapError).code === RC.notAllowedOnNonLeaf);
  d.delete('uid=ana,ou=people,dc=ex,dc=com');
  assert.equal(d.get('uid=ana,ou=people,dc=ex,dc=com'), undefined);
});

test('password schemes round trip and reject wrong passwords', () => {
  for (const s of ['SSHA', 'SSHA256', 'SSHA512', 'SHA', 'CLEARTEXT'] as const) {
    const h = hashPassword(s, 'pässword');
    assert.ok(verifyPassword([h], 'pässword'), s);
    assert.ok(!verifyPassword([h], 'passwor'), s);
    assert.ok(!verifyPassword([h], ''), s);
  }
  assert.notEqual(hashPassword('SSHA', 'x'), hashPassword('SSHA', 'x'));
  assert.ok(verifyPassword(['{SSHA}' + 'AAAA', hashPassword('SSHA', 'ok')], 'ok'));
  assert.ok(!verifyPassword([], 'x'));
  assert.ok(!verifyPassword(['{SSHA}!!!'], 'x'));
});

test('bind: empty password refused, same answer for missing and wrong, lockout', () => {
  let t = 0;
  const d = mk({ now: () => t, bind: { maxFailures: 3, lockMs: 60_000, windowMs: 60_000 } });
  person(d, 'ana', { userPassword: hashPassword('SSHA256', 'right') });
  person(d, 'nopw');
  const dn = 'uid=ana,ou=people,dc=ex,dc=com';
  assert.throws(() => d.bind(dn, ''), (e: unknown) => (e as LdapError).code === RC.unwillingToPerform);
  assert.throws(() => d.bind('', 'x'), (e: unknown) => (e as LdapError).code === RC.unwillingToPerform);
  const fail = (u: string, p: string) => { try { d.bind(u, p); return 'ok'; } catch (e) { return `${(e as LdapError).code}:${(e as Error).message}`; } };
  assert.equal(fail('uid=ghost,ou=people,dc=ex,dc=com', 'x'), fail(dn, 'wrong').replace(/^/, ''));
  assert.equal(fail('uid=nopw,ou=people,dc=ex,dc=com', 'x'), fail('uid=ghost,ou=people,dc=ex,dc=com', 'x'));
  assert.equal(fail(dn, 'right'), 'ok');
  fail(dn, 'w1'); fail(dn, 'w2'); fail(dn, 'w3');
  assert.match(fail(dn, 'right'), /^49/);
  t += 61_000;
  assert.equal(fail(dn, 'right'), 'ok');
});

test('extensible match: dn flag, bit rules, in-chain nesting', () => {
  const d = mk();
  person(d, 'ana', { userAccountControl: '514' });
  person(d, 'bob', { userAccountControl: '512' });
  d.add('cn=inner,ou=groups,dc=ex,dc=com', { objectClass: 'groupOfNames', cn: 'inner', member: 'uid=ana,ou=people,dc=ex,dc=com' });
  d.add('cn=outer,ou=groups,dc=ex,dc=com', { objectClass: 'groupOfNames', cn: 'outer', member: 'CN=Inner,OU=Groups,DC=ex,DC=com' });
  const q = (f: string) => d.search('dc=ex,dc=com', f).entries.map((e) => e.dn.split(',')[0]);
  assert.deepEqual(q('(userAccountControl:1.2.840.113556.1.4.803:=2)'), ['uid=ana']);
  assert.deepEqual(q('(userAccountControl:1.2.840.113556.1.4.804:=514)').sort(), ['uid=ana', 'uid=bob']);
  assert.deepEqual(q('(ou:dn:=people)').length > 1, true);
  assert.deepEqual(q('(ou=people)'), ['ou=people']);
  assert.deepEqual(q('(memberOf:1.2.840.113556.1.4.1941:=cn=outer,ou=groups,dc=ex,dc=com)'), ['cn=inner', 'uid=ana']);
  assert.deepEqual(q('(memberOf:1.2.840.113556.1.4.1941:=cn=inner,ou=groups,dc=ex,dc=com)'), ['uid=ana']);
});

test('group resolution through nesting, cycles, roles by DN or name', () => {
  const d = mk();
  person(d, 'ana');
  d.add('cn=a,ou=groups,dc=ex,dc=com', { objectClass: 'groupOfNames', cn: 'a', member: ['uid=ana,ou=people,dc=ex,dc=com', 'cn=b,ou=groups,dc=ex,dc=com'] });
  d.add('cn=b,ou=groups,dc=ex,dc=com', { objectClass: 'groupOfNames', cn: 'b', member: 'cn=a,ou=groups,dc=ex,dc=com' });
  d.add('cn=c,ou=groups,dc=ex,dc=com', { objectClass: 'groupOfNames', cn: 'c', member: 'cn=b,ou=groups,dc=ex,dc=com' });
  const r = resolveGroups(d, 'uid=ana,ou=people,dc=ex,dc=com', { roles: { A: ['admin'], 'CN=C,OU=Groups,DC=ex,DC=com': ['auditor', 'admin'] } });
  assert.deepEqual(r.groups, ['cn=a,ou=groups,dc=ex,dc=com', 'cn=b,ou=groups,dc=ex,dc=com', 'cn=c,ou=groups,dc=ex,dc=com']);
  assert.deepEqual(r.roles, ['admin', 'auditor']);
  assert.deepEqual(resolveGroups(d, 'uid=nobody,dc=ex', { roles: {} }).groups, []);
});

test('attribute mapping: first-of, join, many, default, required, lowercase', () => {
  const d = mk();
  person(d, 'ana', { givenName: 'Ana', sn: 'Lee', mobile: ['1', '2'] });
  const e = d.get('uid=ana,ou=people,dc=ex,dc=com')!;
  const m = mapEntry(e, {
    id: { from: 'uid', required: true },
    email: { from: ['userPrincipalName', 'mail'], lowercase: true },
    name: { from: 'cn', join: { attrs: ['givenName', 'sn'], with: ' ' } },
    phones: { from: 'mobile', many: true },
    locale: { from: 'preferredLanguage', default: 'en' },
    dept: { from: 'departmentNumber' },
  });
  assert.deepEqual(m, { id: 'ana', email: 'ana@ex.com', name: 'Ana Lee', phones: ['1', '2'], locale: 'en' });
  assert.throws(() => mapEntry(e, { x: { from: 'employeeNumber', required: true } }), (x: unknown) => x instanceof MappingError && x.field === 'x');
});

test('user sync plan: create, update, disable, reactivate, mass-disable refusal', () => {
  const app = [
    { id: 'a', fields: { name: 'A' }, active: true },
    { id: 'b', fields: { name: 'B' }, active: true },
    { id: 'c', fields: { name: 'C' }, active: false },
    { id: 'd', fields: { name: 'D' }, active: true },
    { id: 'e', fields: { name: 'E' }, active: true },
    { id: 'f', fields: { name: 'F' }, active: true },
  ];
  const dir = [
    { id: 'a', fields: { name: 'A' } },
    { id: 'b', fields: { name: 'B2' } },
    { id: 'c', fields: { name: 'C' } },
    { id: 'n', fields: { name: 'N' } },
    { id: 'd', fields: { name: 'D' } },
    { id: 'f', fields: { name: 'F' } },
    { id: 'n', fields: { name: 'dup' } },
  ];
  const p = planUserSync(dir, app);
  assert.deepEqual(p.create.map((x) => x.id), ['n']);
  assert.deepEqual(p.update, [{ id: 'b', changes: { name: { from: 'B', to: 'B2' } } }]);
  assert.deepEqual(p.disable, ['e']);
  assert.deepEqual(p.reactivate, ['c']);
  assert.equal(p.unchanged, 3);
  assert.equal(p.errors.length, 1);
  assert.throws(() => planUserSync([], app), SyncRefused);
  assert.throws(() => planUserSync([{ id: 'a', fields: {} }], app), SyncRefused);
  assert.equal(planUserSync([], app, { maxDisableFraction: 1 }).disable.length, 5);
});

test('normalizeDn is stable for already normal forms', () => {
  const n = normalizeDn('CN=A\\,B,dc=x');
  assert.equal(normalizeDn(n), n);
});
