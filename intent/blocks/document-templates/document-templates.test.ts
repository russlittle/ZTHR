import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TemplateLibrary, TemplateProblems, checkData, checkTemplate, fillRole, hashTemplate, lookup, merge, parseMerge, renderBlocks } from './index.ts';
import type { Problem, Template } from './index.ts';

const invoice: Template = {
  id: 'invoice',
  name: 'Invoice {{number}}',
  roles: [{ id: 'issuer', label: 'Issuer' }, { id: 'client', label: 'Client' }],
  fields: [
    { name: 'number', type: 'text', label: 'Invoice number', role: 'issuer', required: true },
    { name: 'date', type: 'date', label: 'Date', role: 'issuer', required: true },
    { name: 'client', type: 'text', label: 'Client name', role: 'issuer', required: true },
    { name: 'note', type: 'text', label: 'Note', role: 'issuer' },
    { name: 'terms', type: 'choice', label: 'Terms', role: 'issuer', choices: ['net15', 'net30'] },
    { name: 'total', type: 'money', label: 'Total', role: 'issuer', required: true },
    { name: 'items', type: 'list', label: 'Line items', role: 'issuer', required: true, item: [{ name: 'description', type: 'text', label: 'Description', required: true }, { name: 'qty', type: 'number', label: 'Quantity', required: true }, { name: 'price', type: 'money', label: 'Price', required: true }] },
    { name: 'signedBy', type: 'text', label: 'Signed by', role: 'client', required: true },
  ],
  body: [
    { h: 'Invoice {{number}}' },
    { p: 'Billed to {{client | upper}} on {{date | date:"long"}}.' },
    { if: { exists: 'note' }, then: [{ p: 'Note: {{note}}' }] },
    { table: { header: ['#', 'Description', 'Qty', 'Price'], widths: [1, 6, 1, 2], repeat: { over: 'items', as: 'item', cells: ['{{loop.index}}', '{{item.description}}', '{{item.qty | number:0}}', '{{item.price | money}}'] } } },
    { p: 'Total due: {{total | money}}' },
    { if: { eq: ['terms', 'net30'] }, then: [{ p: 'Payable within 30 days.' }], else: [{ p: 'Payable within 15 days.' }] },
    { p: 'Signed: {{signedBy | default:"(unsigned)"}}' },
  ],
};
const money = (minor: number, currency = 'USD') => ({ minor, currency });
const data = {
  number: 'INV-7',
  date: '2025-03-09',
  client: 'Acme Ltd',
  terms: 'net30',
  total: money(123450),
  signedBy: 'Zed',
  items: [{ description: 'Design', qty: 2, price: money(50000) }, { description: 'Hosting', qty: 1, price: money(23450) }],
};
const text = (blocks: ReturnType<typeof renderBlocks>) => JSON.stringify(blocks);
const problemsOf = (f: () => unknown): Problem[] => {
  try {
    f();
  } catch (e) {
    assert.ok(e instanceof TemplateProblems, String(e));
    return [...e.problems];
  }
  return [];
};

test('merge syntax: pieces, filters with arguments, and an escaped brace', () => {
  assert.deepEqual(parseMerge('Hi {{ a.b | upper | default:"x y" }}, \\{{literal}} done'), ['Hi ', { path: 'a.b', filters: [{ name: 'upper', arg: undefined }, { name: 'default', arg: 'x y' }] }, ', {{literal}} done']);
  assert.deepEqual(parseMerge('{{n|number:2}}'), [{ path: 'n', filters: [{ name: 'number', arg: 2 }] }]);
  assert.deepEqual(parseMerge('plain'), ['plain']);
  assert.match(problemsOf(() => parseMerge('oops {{a'))[0]!.message, /closing/);
  assert.match(problemsOf(() => parseMerge('{{a | nope}}'))[0]!.message, /unknown filter/);
  assert.match(problemsOf(() => parseMerge('{{a b}}'))[0]!.message, /not a field path/);
  assert.match(problemsOf(() => parseMerge('{{a | default:"x}}'))[0]!.message, /unclosed/);
  assert.equal(problemsOf(() => parseMerge('{{ a.__proto__ }}')).length, 0, 'it parses; lookup is what refuses it');
});

test('filters format values the way the locale does', () => {
  const sc = [{ m: money(123456), n: 1234.5, d: '2025-03-09', xs: ['a', 'b'], s: 'hELLO wORLD' }];
  const run = (t: string, locale?: string) => {
    const ps: Problem[] = [];
    const out = merge(t, sc, locale ? { locale } : {}, 'x', ps);
    assert.deepEqual(ps, [], t);
    return out;
  };
  assert.equal(run('{{m | money}}'), '$1,234.56');
  assert.equal(run('{{m | money}}', 'de-DE'), '1.234,56 $');
  assert.equal(run('{{n | number:2}}'), '1,234.50');
  assert.equal(run('{{d | date:"long"}}'), 'March 9, 2025');
  assert.equal(run('{{d | date:"short"}}'), '3/9/25');
  assert.equal(run('{{d | date:"long"}}', 'fr-FR'), '9 mars 2025');
  assert.equal(run('{{xs | join:" / "}} {{xs | count}}'), 'a / b 2');
  assert.equal(run('{{s | title}} {{s | lower}} {{s | trim | truncate:5}}'), 'Hello World hello world hELL…');
  assert.equal(run('{{missing | default:"none"}}'), 'none');
});

test('zero-decimal currencies use their own minor units', () => {
  const ps: Problem[] = [];
  assert.equal(merge('{{y | money}}', [{ y: money(1500, 'JPY') }], {}, 'x', ps), '¥1,500');
  assert.equal(merge('{{k | money}}', [{ k: money(12345, 'KWD') }], {}, 'x', ps), 'KWD 12.345');
  assert.deepEqual(ps, []);
});

test('rendering expands fields, a repeating table with loop numbers, conditions and the title', () => {
  const blocks = renderBlocks(invoice, data);
  assert.deepEqual(blocks[0], { h: 'Invoice INV-7' });
  assert.deepEqual(blocks[1], { p: 'Billed to ACME LTD on March 9, 2025.' });
  const table = blocks.find((b) => 'table' in b) as { table: string[][]; widths: number[] };
  assert.deepEqual(table.table, [['#', 'Description', 'Qty', 'Price'], ['1', 'Design', '2', '$500.00'], ['2', 'Hosting', '1', '$234.50']]);
  assert.deepEqual(table.widths, [1, 6, 1, 2]);
  assert.ok(blocks.some((b) => 'p' in b && b.p === 'Total due: $1,234.50'));
  assert.ok(blocks.some((b) => 'p' in b && b.p === 'Payable within 30 days.'));
  assert.ok(!text(blocks).includes('Note:'), 'the condition on an absent note left it out');
  assert.ok(blocks.some((b) => 'p' in b && b.p === 'Signed: Zed'));
  assert.ok(!text(blocks).includes('{{'));
});

test('a section can repeat, with first and last markers and a nested condition', () => {
  const t: Template = {
    id: 'agenda', name: 'Agenda', roles: [], fields: [{ name: 'topics', type: 'list', label: 'Topics', item: [{ name: 'title', type: 'text', label: 'Title' }] }],
    body: [{ repeat: { over: 'topics', as: 't', body: [{ h: '{{loop.index}}/{{loop.length}} {{t.title}}' }, { if: { eq: ['loop.last', true] }, then: [{ p: 'end' }] }] } }],
  };
  const out = renderBlocks(t, { topics: [{ title: 'A' }, { title: 'B' }, { title: 'C' }] });
  assert.deepEqual(out.map((b) => ('h' in b ? b.h : 'p' in b ? b.p : '?')), ['1/3 A', '2/3 B', '3/3 C', 'end']);
});

test('rendering is strict: every problem is reported at once and nothing half-merged comes out', () => {
  const ps = problemsOf(() => renderBlocks(invoice, { ...data, client: undefined, date: '2025-02-30', items: [{ description: 'x', qty: 'two', price: money(1) }] }));
  const where = ps.map((p) => p.where).sort();
  assert.deepEqual(where, ['data.client', 'data.date', 'data.items[0].qty']);
  assert.match(ps.find((p) => p.where === 'data.client')!.message, /Client name is required/);
  const t: Template = { ...invoice, fields: invoice.fields.map((f) => (f.name === 'client' ? { ...f, required: false } : f)) };
  const missing = problemsOf(() => renderBlocks(t, { ...data, client: undefined }));
  assert.deepEqual(missing.map((p) => p.message), ['no value for client'], 'an optional field that the body needs is still a problem');
});

test('a draft shows «placeholders» where values are missing, and says nothing about required fields', () => {
  const blocks = renderBlocks(invoice, { number: 'INV-8' }, { draft: true });
  assert.deepEqual(blocks[0], { h: 'Invoice INV-8' });
  assert.ok(text(blocks).includes('Billed to «client» on «date»'));
});

test('fields are read only from own properties: prototype paths and inherited values are not data', () => {
  assert.equal(lookup([{}], '__proto__.polluted'), undefined);
  assert.equal(lookup([{ a: {} }], 'a.constructor.name'), undefined);
  assert.equal(lookup([Object.create({ inherited: 1 }) as Record<string, unknown>], 'inherited'), undefined);
  assert.equal(lookup([{ a: [10, 20] }], 'a.1'), 20);
  assert.equal(lookup([{ x: 1 }, { x: 2 }], 'x'), 2, 'the innermost scope wins');
  const t: Template = { id: 'p', name: 'p', roles: [], fields: [{ name: 'a', type: 'text', label: 'A' }], body: [{ p: '{{constructor.name}} {{__proto__}}' }] };
  assert.ok(checkTemplate(t).length >= 2, 'undeclared');
  assert.equal(({} as Record<string, unknown>)['polluted'], undefined);
});

test('a value that is an object or list cannot be dropped into text', () => {
  const t: Template = { id: 'o', name: 'o', roles: [], fields: [{ name: 'items', type: 'list', label: 'Items', item: [{ name: 'n', type: 'text', label: 'N' }] }], body: [{ p: 'x {{items}}' }] };
  assert.match(problemsOf(() => renderBlocks(t, { items: [{ n: 'a' }] }))[0]!.message, /not a single value/);
});

test('a template is checked before any data: undeclared fields, loop names, roles, filters, list targets', () => {
  const bad: Template = {
    id: 'Bad ID', name: 'n', roles: [{ id: 'a', label: 'A' }],
    fields: [{ name: 'x', type: 'text', label: 'X', role: 'ghost' }, { name: 'c', type: 'choice', label: 'C' }, { name: 'l', type: 'list', label: 'L' }],
    body: [{ p: '{{nope}}' }, { p: '{{x | bogus}}' }, { repeat: { over: 'x', as: 'r', body: [] } }, { table: { repeat: { over: 'l', as: 'r', cells: ['{{r.zzz}}'] } } }, { if: { exists: 'missing' }, then: [] }, { space: -1 }],
  };
  const ms = checkTemplate(bad).map((p) => `${p.where}: ${p.message}`);
  for (const frag of ['id: an id is lower-case', 'field x: the role ghost is not declared', 'field c: a choice needs choices', 'field l: a list needs item fields', 'nope is not a declared field', 'unknown filter', 'x is not a list field', 'r.zzz is not a declared field', 'missing is not a declared field', 'space is 0 to 400']) assert.ok(ms.some((m) => m.includes(frag)), frag);
  assert.deepEqual(checkTemplate(invoice), []);
});

test('data is checked by type: dates must be real, choices from the list, money in minor units, lists of objects, nothing undeclared', () => {
  const fields = invoice.fields;
  const base = { ...data };
  assert.deepEqual(checkData(fields, base), []);
  const cases: [Record<string, unknown>, string][] = [
    [{ date: '2025-02-30' }, 'data.date'], [{ date: '9 March' }, 'data.date'], [{ terms: 'net45' }, 'data.terms'], [{ total: { minor: 12.5, currency: 'USD' } }, 'data.total'],
    [{ total: '12.50' }, 'data.total'], [{ items: 'none' }, 'data.items'], [{ items: ['x'] }, 'data.items[0]'], [{ extra: 1 }, 'data.extra'], [{ number: 7 }, 'data.number'], [{ items: [{ description: 'a', qty: Infinity, price: money(1) }] }, 'data.items[0].qty'],
  ];
  for (const [patch, where] of cases) assert.ok(checkData(fields, { ...base, ...patch }).some((p) => p.where === where), where);
});

test('roles: each fills only its own fields, and progress shows who is still to do what', () => {
  const issuerData = fillRole(invoice, 'issuer', {}, { number: 'INV-9', date: '2025-01-01', client: 'Zed', total: money(100), items: [{ description: 'd', qty: 1, price: money(100) }] });
  const lib = new TemplateLibrary();
  assert.deepEqual(lib.progress(invoice, issuerData).map((r) => [r.role, r.done, r.missing]), [['issuer', true, []], ['client', false, ['Signed by']]]);
  assert.deepEqual(problemsOf(() => fillRole(invoice, 'client', issuerData, { signedBy: 'Zed', total: money(1) })).map((p) => p.message), ['Total is not for client to fill']);
  assert.deepEqual(problemsOf(() => fillRole(invoice, 'client', issuerData, { signedBy: 7 })).map((p) => p.where), ['data.signedBy']);
  assert.deepEqual(problemsOf(() => fillRole(invoice, 'nobody', {}, {})).map((p) => p.message), ['no role nobody']);
  const done = fillRole(invoice, 'client', issuerData, { signedBy: 'Zed' });
  assert.equal(lib.progress(invoice, done).every((r) => r.done), true);
  assert.equal(done['number'], 'INV-9', 'earlier values are kept');
});

test('versions: publishing the same content again is the same version; a change is a new one; published versions are frozen', () => {
  const t = { now: 1000 };
  const lib = new TemplateLibrary({ now: () => t.now });
  const v1 = lib.publish(invoice);
  t.now = 2000;
  assert.equal(lib.publish(structuredClone(invoice)), v1, 'unchanged');
  assert.deepEqual([v1.version, v1.publishedAt, v1.hash.length], [1, 1000, 64]);
  const changed: Template = { ...invoice, body: [...invoice.body, { p: 'Thank you.' }], fields: [...invoice.fields, { name: 'po', type: 'text', label: 'PO', required: true, role: 'issuer' }] };
  const v2 = lib.publish(changed);
  assert.deepEqual([v2.version, v2.publishedAt], [2, 2000]);
  assert.equal(lib.get('invoice').version, 2);
  assert.equal(lib.get('invoice', 1), v1);
  assert.throws(() => lib.get('invoice', 3), TemplateProblems);
  assert.throws(() => lib.get('nope'), TemplateProblems);
  assert.throws(() => ((v1.body as unknown as unknown[])[0] as { h: string }).h.length && Object.assign(v1.body[0]!, { h: 'changed' }), TypeError);
  assert.deepEqual(lib.changes('invoice', 1, 2), ['field added: po (required)', 'body changed']);
  assert.deepEqual(lib.list(), [{ id: 'invoice', name: 'Invoice {{number}}', latest: 2 }]);
  assert.throws(() => lib.publish({ ...invoice, body: [{ p: '{{undeclared}}' }] }), TemplateProblems);
});

test('a template hash does not depend on key order, and does depend on content', () => {
  const a = hashTemplate(invoice);
  const reordered = { body: invoice.body, fields: invoice.fields, roles: invoice.roles, name: invoice.name, id: invoice.id } as Template;
  assert.equal(hashTemplate(reordered), a);
  assert.notEqual(hashTemplate({ ...invoice, name: 'Bill' }), a);
});

test('changes between versions report type, requirement and role changes', () => {
  const lib = new TemplateLibrary();
  lib.publish(invoice);
  lib.publish({ ...invoice, body: invoice.body.filter((n) => !('if' in n && 'exists' in n.if)), fields: invoice.fields.filter((f) => f.name !== 'note').map((f) => (f.name === 'terms' ? { ...f, required: true } : f.name === 'date' ? { ...f, type: 'text' as const } : f.name === 'total' ? { ...f, role: 'client' } : f)) });
  assert.deepEqual(lib.changes('invoice', 1, 2), ['field removed: note', 'field date: type date became text', 'field terms: now required', 'field total: role issuer became client', 'body changed']);
});

test('the PDF is real, carries the merged text, and is footed with template, version and hash', () => {
  const lib = new TemplateLibrary({ now: () => 5 });
  const v = lib.publish(invoice);
  const full = { ...data };
  const r = lib.render('invoice', full);
  const s = r.pdf.toString('latin1');
  assert.ok(s.startsWith('%PDF-1.7'));
  assert.ok(s.includes('(Invoice INV-7)'));
  assert.ok(s.includes('Total due: $1,234.50'));
  assert.ok(s.includes('Signed: Zed'));
  assert.ok(s.includes(`invoice v1 ${v.hash.slice(0, 8)} - page 1 of 1`));
  assert.ok(s.includes('/Title (Invoice INV-7)'));
  assert.deepEqual([r.stamp.template, r.stamp.version, r.stamp.templateHash, r.stamp.renderedAt], ['invoice', 1, v.hash, 5]);
  assert.equal(lib.render('invoice', full).stamp.dataHash, r.stamp.dataHash, 'the same data, the same hash');
  assert.notEqual(lib.render('invoice', { ...full, client: 'Other' }).stamp.dataHash, r.stamp.dataHash);
  const draft = lib.render('invoice', { number: 'D-1' }, { draft: true }).pdf.toString('latin1');
  assert.ok(draft.includes('DRAFT'));
});

test('an old version still renders as it did after a new one is published', () => {
  const lib = new TemplateLibrary();
  lib.publish(invoice);
  lib.publish({ ...invoice, body: [{ h: 'Tax invoice {{number}}' }] });
  const full = { ...data };
  assert.ok(lib.render('invoice', full, { version: 1 }).pdf.toString('latin1').includes('Billed to ACME LTD'));
  assert.ok(lib.render('invoice', full).pdf.toString('latin1').includes('Tax invoice INV-7'));
});

test('limits: too many repeated items, and runaway output, are refused', () => {
  const t: Template = { id: 'big', name: 'Big', roles: [], fields: [{ name: 'xs', type: 'list', label: 'Xs', item: [{ name: 'v', type: 'text', label: 'V' }] }], body: [{ repeat: { over: 'xs', as: 'x', body: [{ p: '{{x.v}}' }] } }] };
  assert.match(problemsOf(() => renderBlocks(t, { xs: Array.from({ length: 1001 }, () => ({ v: 'a' })) }))[0]!.message, /more than 1000/);
  assert.equal(renderBlocks(t, { xs: Array.from({ length: 1000 }, () => ({ v: 'a' })) }).length, 1000);
  const nested: Template = { id: 'n', name: 'n', roles: [], fields: [{ name: 'xs', type: 'list', label: 'Xs', item: [{ name: 'v', type: 'text', label: 'V' }] }], body: [{ repeat: { over: 'xs', as: 'x', body: [{ repeat: { over: 'xs', as: 'y', body: [{ p: 'row' }] } }] } }] };
  assert.ok(problemsOf(() => renderBlocks(nested, { xs: Array.from({ length: 100 }, () => ({ v: 'a' })) })).some((p) => /blocks of output/.test(p.message)));
  const deep: Template = { ...t, body: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].reduce<Template['body']>((inner) => [{ if: { exists: 'xs' }, then: inner }], [{ p: 'x' }]) };
  assert.ok(checkTemplate(deep).some((p) => /nested too deeply/.test(p.message)));
});
