import assert from 'node:assert/strict';
import { test } from 'node:test';
import { breadcrumbs, check, evaluate, find, insert, InvalidCondition, InvalidMenu, move, pick, remove, resolve, safeHref } from './index.ts';
import type { Condition, Context, MenuItem } from './index.ts';

const menu: MenuItem[] = [
  { id: 'home', label: { en: 'Home', fr: 'Accueil', de: 'Start' }, href: '/' },
  {
    id: 'docs',
    label: 'Docs',
    href: '/docs',
    match: 'prefix',
    children: [
      { id: 'docs-start', label: 'Getting started', href: '/docs/start' },
      { id: 'docs-api', label: 'API', href: '/docs/api', children: [{ id: 'docs-api-auth', label: 'Auth', href: '/docs/api/auth' }] },
      { id: 'docs-internal', label: 'Internal', href: '/docs/internal', permission: 'docs.internal' },
    ],
  },
  {
    id: 'account',
    label: 'Account',
    when: { authenticated: true },
    children: [
      { id: 'profile', label: 'Profile', href: '/me' },
      { id: 'admin', label: 'Admin', href: '/admin', when: { role: ['admin', 'owner'] }, match: ['/admin/*', '/settings'] },
      { id: 'beta', label: 'Beta', href: '/beta', when: { all: [{ flag: 'beta' }, { not: { locale: 'fr' } }] } },
    ],
  },
  { id: 'login', label: 'Sign in', href: '/login', when: { authenticated: false } },
  { id: 'ext', label: 'Blog', href: 'https://blog.example.com', target: '_blank', order: -1 },
  { id: 'empty-group', label: 'Nothing here', children: [{ id: 'gone', label: 'Gone', href: '/g', permission: 'never' }] },
];
const ids = (r: ReturnType<typeof resolve>) => r.items.map((i) => i.id);

test('a signed-out visitor sees the public items in order, the sign-in link, and no empty group', () => {
  const r = resolve(menu, { path: '/', locale: 'en' });
  assert.deepEqual(ids(r), ['ext', 'home', 'docs', 'login']);
  assert.equal(r.items[0]!.external, true, 'a link to another site is marked external');
  assert.equal(r.items[0]!.target, '_blank');
  assert.deepEqual(r.items[2]!.children.map((c) => c.id), ['docs-start', 'docs-api'], 'the permission-gated page is hidden');
  assert.deepEqual(r.hidden.map((h) => h.id).sort(), ['account', 'docs-internal', 'empty-group', 'gone'].sort());
  assert.equal(r.hidden.find((h) => h.id === 'docs-internal')!.reason, 'needs the permission docs.internal');
  assert.equal(r.hidden.find((h) => h.id === 'account')!.reason, 'its condition is not met');
  assert.equal(r.hidden.find((h) => h.id === 'empty-group')!.reason, 'nothing in it is visible');
});

test('conditions and permissions: roles, flags, locale, sign-in state, and a permission function', () => {
  const ctx: Context = { path: '/me', authenticated: true, roles: ['admin'], flags: { beta: true }, locale: 'en', can: (p) => p === 'docs.internal' };
  const r = resolve(menu, ctx);
  assert.deepEqual(ids(r), ['ext', 'home', 'docs', 'account']);
  assert.deepEqual(r.items[3]!.children.map((c) => c.id), ['profile', 'admin', 'beta']);
  assert.ok(r.items[2]!.children.some((c) => c.id === 'docs-internal'));
  const fr = resolve(menu, { ...ctx, locale: 'fr-CA' });
  assert.deepEqual(fr.items[3]!.children.map((c) => c.id), ['profile', 'admin'], 'beta is not for French');
  const noRole = resolve(menu, { authenticated: true, roles: ['editor'], flags: { beta: false } });
  assert.deepEqual(noRole.items.find((i) => i.id === 'account')!.children.map((c) => c.id), ['profile']);
  assert.equal(resolve(menu, { authenticated: true, roles: ['x'], can: () => true }).items.some((i) => i.id === 'login'), false);
});

test('condition tests behave as written, nest, and refuse shapes they do not know', () => {
  const ctx: Context = { authenticated: true, roles: ['a'], flags: { f: true, g: false }, locale: 'pt-BR', data: { plan: { tier: 'pro', seats: 5 }, list: [1, 2] } };
  const t = (c: Condition) => evaluate(c, ctx);
  assert.equal(t({ authenticated: true }), true);
  assert.equal(t({ role: 'a' }), true);
  assert.equal(t({ role: ['b', 'c'] }), false);
  assert.equal(t({ flag: 'f' }), true);
  assert.equal(t({ flag: 'g' }), false);
  assert.equal(t({ flag: 'unset' }), false);
  assert.equal(t({ flag: 'toString' }), false, 'inherited names are not flags');
  assert.equal(t({ locale: 'pt' }), true, 'a language matches its regions');
  assert.equal(t({ locale: ['de', 'pt-br'] }), true);
  assert.equal(t({ equals: { path: 'plan.tier', value: 'pro' } }), true);
  assert.equal(t({ equals: { path: 'plan.seats', value: 4 } }), false);
  assert.equal(t({ equals: { path: 'list', value: [1, 2] } }), true);
  assert.equal(t({ exists: 'plan.seats' }), true);
  assert.equal(t({ exists: 'plan.nope' }), false);
  assert.equal(t({ exists: 'constructor' }), false, 'own properties only');
  assert.equal(t({ any: [{ flag: 'g' }, { role: 'a' }] }), true);
  assert.equal(t({ all: [] }), true);
  assert.equal(t({ any: [] }), false);
  assert.equal(t({ not: { flag: 'g' } }), true);
  for (const bad of [{}, { flag: 1 }, { all: 'x' }, { nope: 1 }, { flag: 'a', role: 'b' }, { authenticated: 'yes' }, { equals: {} }, null, 'x'])
    assert.throws(() => t(bad as never), InvalidCondition, JSON.stringify(bad));
  let deep: Condition = { flag: 'f' };
  for (let i = 0; i < 20; i++) deep = { not: deep };
  assert.throws(() => t(deep), /nested deeper/);
  const broken: MenuItem[] = [{ id: 'x', label: 'X', href: '/x', when: { nope: 1 } as never }, { id: 'y', label: 'Y', href: '/y' }];
  const r = resolve(broken);
  assert.deepEqual(ids(r), ['y'], 'a broken condition hides the item instead of showing it');
  assert.match(r.hidden[0]!.reason, /condition is broken/);
});

test('labels and addresses follow the language with fallbacks; an item with no label anywhere is left out and reported', () => {
  assert.equal(pick({ en: 'Home', fr: 'Accueil' }, 'fr-CA'), 'Accueil');
  assert.equal(pick({ en: 'Home', 'pt-BR': 'Início', pt: 'Inicio' }, 'pt-BR'), 'Início');
  assert.equal(pick({ en: 'Home', pt: 'Inicio' }, 'pt-PT'), 'Inicio');
  assert.equal(pick({ en: 'Home' }, 'de', ['fr', 'en']), 'Home');
  assert.equal(pick({ en: 'Home' }, 'de'), undefined);
  assert.equal(pick({ en: '' }, 'en'), undefined, 'an empty translation is no translation');
  assert.equal(pick('Same', 'de'), 'Same');
  assert.equal(pick({ EN: 'Up' }, 'en'), 'Up');
  assert.equal(pick({ __proto__: null, constructor: 'x' } as never, 'constructor'), 'x');
  assert.equal(pick({ en: 'x' }, 'toString'), undefined);
  const r = resolve(menu, { locale: 'fr', fallbackLocales: [] });
  assert.equal(r.items.find((i) => i.id === 'home')!.label, 'Accueil');
  assert.deepEqual(r.missing, [], 'plain-string labels exist in every language');
  const only = resolve([{ id: 'a', label: { en: 'A' }, href: '/a' }], { locale: 'ja' });
  assert.deepEqual(only.items, []);
  assert.deepEqual(only.missing, [{ id: 'a', what: 'label', locale: 'ja' }]);
  assert.equal(resolve([{ id: 'a', label: { en: 'A' }, href: '/a' }], { locale: 'ja', fallbackLocales: ['en'] }).items[0]!.label, 'A');
  const loc = resolve([{ id: 'a', label: 'A', href: { en: '/about', fr: '/a-propos' } }], { locale: 'fr' });
  assert.equal(loc.items[0]!.href, '/a-propos');
});

test('unsafe addresses are never linked', () => {
  for (const ok of ['/a', '/a?b=1#c', '#top', 'https://x.test/a', 'HTTP://x.test', 'mailto:a@b.c', 'tel:+123', 'relative/path', '?page=2']) assert.equal(safeHref(ok), true, ok);
  for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', 'data:text/html,x', 'vbscript:x', '//evil.test/x', '/a b', '', '/a\nb', 'file:///etc/passwd', 'x'.repeat(3000)]) assert.equal(safeHref(bad), false, JSON.stringify(bad.slice(0, 25)));
  const r = resolve([{ id: 'evil', label: 'Evil', href: 'javascript:alert(1)' }, { id: 'group', label: 'G', href: 'data:x', children: [{ id: 'k', label: 'K', href: '/k' }] }]);
  assert.deepEqual(ids(r), ['group'], 'the unsafe link is dropped; a group keeps its children');
  assert.equal(r.items[0]!.href, undefined);
  assert.deepEqual(r.dropped.map((d) => d.id), ['evil', 'group']);
});

test('the active item: exact beats prefix, longer beats shorter, deeper breaks ties; the trail is marked', () => {
  const r = resolve(menu, { path: '/docs/api/auth' });
  assert.equal(r.active!.id, 'docs-api-auth');
  const docs = r.items.find((i) => i.id === 'docs')!;
  assert.deepEqual([docs.current, docs.children[1]!.current, docs.children[1]!.children[0]!.current, docs.children[0]!.current], ['trail', 'trail', 'page', null]);
  assert.equal(docs.active, false);
  assert.equal(resolve(menu, { path: '/docs/api/other' }).active!.id, 'docs', 'a prefix item holds everything below it');
  assert.equal(resolve(menu, { path: '/docs/api' }).active!.id, 'docs-api', 'exact beats the parent prefix');
  assert.equal(resolve(menu, { path: '/docs' }).active!.id, 'docs');
  assert.equal(resolve(menu, { path: '/docs/apiary' }).active!.id, 'docs', 'below the prefix item, and not matching the API item by string prefix');
  assert.equal(resolve(menu, { path: '/documents' }).active, null, 'a prefix is a whole path part, not a string prefix');
  assert.equal(resolve(menu, { path: '/' }).active!.id, 'home');
  assert.equal(resolve(menu, { path: '/nowhere' }).active, null);
  assert.equal(resolve(menu, { path: '/docs/start/?utm=1#x' }).active!.id, 'docs-start', 'query, fragment and trailing slash do not matter');
  assert.equal(resolve(menu, { path: '//docs//start' }).active!.id, 'docs-start');
  assert.equal(resolve(menu, { path: '/%64ocs/start' }).active!.id, 'docs-start', 'percent-encoded letters are decoded');
});

test('match rules: listed patterns and trailing /* prefixes; external and hidden items are never active', () => {
  const ctx: Context = { authenticated: true, roles: ['admin'] };
  assert.equal(resolve(menu, { ...ctx, path: '/admin/users/4' }).active!.id, 'admin');
  assert.equal(resolve(menu, { ...ctx, path: '/settings' }).active!.id, 'admin');
  assert.equal(resolve(menu, { ...ctx, path: '/settings/x' }).active, null, 'only /settings itself was listed');
  assert.equal(resolve(menu, { authenticated: true, roles: [], path: '/admin/users' }).active, null, 'a hidden item cannot be active');
  assert.equal(resolve(menu, { path: 'https://blog.example.com' }).active, null);
  const dup: MenuItem[] = [{ id: 'a', label: 'A', href: '/same' }, { id: 'b', label: 'B', href: '/same' }];
  assert.equal(resolve(dup, { path: '/same' }).active!.id, 'a', 'equal matches: the first');
  assert.equal(resolve([{ id: 'r', label: 'Root', href: '/', match: 'prefix' }], { path: '/anything' }).active!.id, 'r', 'a root prefix holds the whole site');
});

test('breadcrumbs come from the same answer as the active item', () => {
  const r = resolve(menu, { path: '/docs/api/auth' });
  assert.deepEqual(breadcrumbs(r.items), [{ id: 'docs', label: 'Docs', href: '/docs' }, { id: 'docs-api', label: 'API', href: '/docs/api' }, { id: 'docs-api-auth', label: 'Auth', href: '/docs/api/auth' }]);
  assert.deepEqual(breadcrumbs(resolve(menu, { path: '/nowhere' }).items), []);
  assert.deepEqual(breadcrumbs(resolve(menu, { path: '/' }).items).map((b) => b.id), ['home']);
});

test('order, then document position, decides the sequence', () => {
  const m: MenuItem[] = [{ id: 'c', label: 'C', href: '/c' }, { id: 'a', label: 'A', href: '/a', order: 2 }, { id: 'b', label: 'B', href: '/b', order: 1 }, { id: 'd', label: 'D', href: '/d' }];
  assert.deepEqual(ids(resolve(m)), ['c', 'd', 'b', 'a']);
  assert.deepEqual(ids(resolve([...m, { id: 'z', label: 'Z', href: '/z', order: -5 }])), ['z', 'c', 'd', 'b', 'a']);
});

test('a stored menu is checked: ids, depth, limits, unsafe links, required languages, empty groups, broken conditions', () => {
  const bad: MenuItem[] = [
    { id: 'a', label: 'A', href: '/a' },
    { id: 'a', label: 'Dup', href: '/b' },
    { id: 'bad id', label: 'X', href: '/x' },
    { id: 'js', label: 'J', href: 'javascript:alert(1)' },
    { id: 'en-only', label: { en: 'E' }, href: '/e' },
    { id: 'empty', label: ' ', href: '/e2' },
    { id: 'group', label: 'G', children: [] },
    { id: 'cond', label: 'C', href: '/c', when: { nope: 1 } as never },
    { id: 'perm', label: 'P', href: '/p', permission: ' ' },
    { id: 'l1', label: 'L1', children: [{ id: 'l2', label: 'L2', children: [{ id: 'l3', label: 'L3', children: [{ id: 'l4', label: 'L4', children: [{ id: 'l5', label: 'L5', href: '/l5' }] }] }] }] },
  ];
  const problems = check(bad, { requiredLocales: ['en', 'fr'] }).map((p) => `${p.id}: ${p.problem}`);
  assert.ok(problems.includes('a: the id is used twice'));
  assert.ok(problems.includes('bad id: the id must be letters, digits and _ . : -'));
  assert.ok(problems.includes('js: the address "javascript:alert(1)" cannot be linked'));
  assert.ok(problems.includes('en-only: no label in fr'));
  assert.ok(problems.includes('empty: the label is empty'));
  assert.ok(problems.includes('group: it has no address and nothing in it'));
  assert.ok(problems.includes('cond: not a valid condition: "nope" is not a known test'));
  assert.ok(problems.includes('perm: the permission is empty'));
  assert.ok(problems.some((p) => p.startsWith('l5:') && p.includes('deeper than 4')));
  assert.deepEqual(check(menu), [], 'the sample menu is sound');
  assert.deepEqual(check([{ id: 'a', label: 'A', href: '/a' }], { maxItems: 0 }), [{ id: '', problem: 'the menu has 1 items; the limit is 0' }]);
});

test('editing: insert, remove and move produce new trees, keep ids unique, and refuse cycles', () => {
  const m = menu;
  const added = insert(m, { id: 'new', label: 'New', href: '/new' }, 'docs', 1);
  assert.deepEqual(find(added, 'docs')!.children!.map((c) => c.id), ['docs-start', 'new', 'docs-api', 'docs-internal']);
  assert.equal(find(m, 'new'), undefined, 'the original is not changed');
  assert.deepEqual(insert(m, { id: 'top', label: 'T', href: '/t' }, null, 0).map((i) => i.id)[0], 'top');
  assert.throws(() => insert(m, { id: 'home', label: 'x', href: '/' }), /already an item "home"/);
  assert.throws(() => insert(m, { id: 'z', label: 'x', href: '/' }, 'nope'), /no item "nope"/);
  const moved = move(m, 'docs-api', 'account', 0);
  assert.deepEqual(find(moved, 'account')!.children!.map((c) => c.id), ['docs-api', 'profile', 'admin', 'beta']);
  assert.equal(find(moved, 'docs-api-auth')!.id, 'docs-api-auth', 'its children went with it');
  assert.deepEqual(find(moved, 'docs')!.children!.map((c) => c.id), ['docs-start', 'docs-internal']);
  assert.throws(() => move(m, 'docs', 'docs-api-auth'), InvalidMenu);
  assert.throws(() => move(m, 'docs', 'docs'), /into itself/);
  assert.throws(() => move(m, 'nope', null), InvalidMenu);
  assert.deepEqual(move(m, 'docs-api', null).map((i) => i.id).slice(-1), ['docs-api']);
  const removed = remove(m, 'docs-api');
  assert.equal(find(removed, 'docs-api-auth'), undefined);
  assert.throws(() => remove(m, 'nope'), InvalidMenu);
  assert.equal(JSON.stringify(menu), JSON.stringify(JSON.parse(JSON.stringify(menu))), 'the sample is unchanged by all of the above');
});

test('a hidden parent hides its whole subtree even if a child would pass; a group with only unsafe children disappears', () => {
  const m: MenuItem[] = [
    { id: 'p', label: 'P', when: { flag: 'x' }, children: [{ id: 'c', label: 'C', href: '/c' }] },
    { id: 'q', label: 'Q', children: [{ id: 'bad', label: 'Bad', href: 'javascript:1' }] },
    { id: 'r', label: 'R', permission: 'view', children: [{ id: 'rc', label: 'RC', href: '/rc' }] },
  ];
  const r = resolve(m, { can: () => true });
  assert.deepEqual(ids(r), ['r']);
  assert.deepEqual(r.hidden.map((h) => h.id).sort(), ['bad', 'p', 'q']);
  assert.deepEqual(ids(resolve(m, { can: () => true, flags: { x: true } })), ['p', 'r']);
  assert.deepEqual(ids(resolve(m, {})), [], 'with no permission function a permission is refused');
});

test('a very large or deeply nested menu resolves quickly, and odd keys in label records are not special', () => {
  let deep: MenuItem = { id: 'leaf', label: 'Leaf', href: '/leaf' };
  for (let i = 0; i < 300; i++) deep = { id: `n${i}`, label: 'N', children: [deep] };
  const wide: MenuItem[] = Array.from({ length: 5000 }, (_, i) => ({ id: `w${i}`, label: `W${i}`, href: `/w/${i}` }));
  const t0 = Date.now();
  const r = resolve([deep, ...wide], { path: '/w/4999' });
  assert.equal(r.active!.id, 'w4999');
  assert.equal(r.items.length, 5001);
  assert.ok(Date.now() - t0 < 3000);
  const weird = resolve([{ id: 'w', label: JSON.parse('{"__proto__":"x","en":"Fine"}') as Record<string, string>, href: '/w' }], { locale: 'en' });
  assert.equal(weird.items[0]!.label, 'Fine');
  assert.equal(check(wide, { maxItems: 100 }).at(-1)!.problem, 'the menu has 5000 items; the limit is 100');
});
