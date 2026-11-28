import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fieldErrors } from '../validate/index.ts';
import { checkForm, confirmation, evaluate, FormError, nextPage, prefill, previousPage, route, submit, validateForm, validatePage, visiblePages, type FormDef } from './index.ts';

const seats = [{ value: 'front', label: 'Front' }, { value: 'back', label: 'Back' }];
const form: FormDef = {
  id: 'signup',
  version: 3,
  title: 'Event signup',
  pages: [
    {
      id: 'about',
      title: 'About you',
      fields: [
        { id: 'name', type: 'text', label: 'Full name', required: true, max: 40 },
        { id: 'email', type: 'email', label: 'Email', required: true },
        { id: 'age', type: 'integer', label: 'Age', required: true, min: 0, max: 120 },
        { id: 'guardian', type: 'text', label: 'Parent or guardian', required: '{age} < 18', visibleWhen: '{age} < 18' },
        { id: 'note', type: 'longtext', label: 'Note for the guardian', visibleWhen: '{guardian} <> ""' },
      ],
    },
    {
      id: 'tickets',
      title: 'Tickets',
      fields: [
        { id: 'kind', type: 'select', label: 'Ticket', required: true, options: [{ value: 'std', label: 'Standard' }, { value: 'vip', label: 'VIP' }] },
        { id: 'qty', type: 'integer', label: 'How many', required: true, min: 1, max: 10, default: 1 },
        { id: 'price', type: 'calculated', label: 'Price', formula: 'IF({kind}="vip",150,60)' },
        { id: 'total', type: 'calculated', label: 'Total', formula: '{price}*{qty}' },
        { id: 'diet', type: 'multiselect', label: 'Dietary needs', max: 2, options: [{ value: 'veg', label: 'Vegetarian' }, { value: 'gf', label: 'Gluten free' }, { value: 'nut', label: 'Nut free' }] },
        { id: 'arrive', type: 'date', label: 'Arrival', min: '2026-06-01', max: '2026-06-30' },
        { id: 'terms', type: 'boolean', label: 'I accept the terms', required: true },
      ],
    },
    { id: 'vip', title: 'VIP extras', visibleWhen: '{kind}="vip"', fields: [{ id: 'seat', type: 'select', label: 'Seat', required: true, options: seats }] },
  ],
  routes: [
    { id: 'big', when: '{total} >= 500', to: { kind: 'email', target: 'sales@example.com' } },
    { id: 'vip', when: '{kind}="vip"', to: { kind: 'webhook', target: 'https://hooks.example.com/vip' } },
    { id: 'rest', otherwise: true, to: { kind: 'queue', target: 'signups' } },
  ],
  confirmation: 'Thanks {name}! Your total is {total}.',
};
const adult = { name: 'Ada Lovelace', email: 'ada@example.com', age: 36, kind: 'std', qty: 2, terms: true };
const probs = (r: ReturnType<typeof validateForm>) => (r.ok ? [] : r.problems.map((p) => `${p.path}: ${p.message}`));

test('a sound definition has nothing to report', () => {
  assert.deepEqual(checkForm(form), []);
});

test('authoring mistakes are found before anyone fills the form in', () => {
  const bad = (f: Partial<FormDef>) => checkForm({ ...form, ...f });
  const pg = (fields: FormDef['pages'][number]['fields']) => ({ routes: [], confirmation: 'ok', pages: [{ id: 'p', title: 'P', fields }] });
  assert.ok(bad({ pages: [] }).includes('a form needs at least one page'));
  assert.ok(bad(pg([{ id: 'a', type: 'text', label: 'A' }, { id: 'a', type: 'text', label: 'A2' }])).includes('field id "a" is used twice'));
  assert.ok(bad(pg([{ id: 'a b', type: 'text', label: 'A' }])).some((p) => p.includes('"a b" is not allowed')));
  assert.ok(bad(pg([{ id: 'a', type: 'text', label: 'A', visibleWhen: '{nope} = 1' }])).includes('the visibility of "a" names the field "nope", which does not exist'));
  assert.ok(bad(pg([{ id: 'a', type: 'text', label: 'A', visibleWhen: '{a} = (' }])).some((p) => p.startsWith('the visibility of "a" is not a valid rule')));
  assert.ok(bad(pg([{ id: 'a', type: 'calculated', label: 'A', formula: '{b}+1' }, { id: 'b', type: 'calculated', label: 'B', formula: '{a}+1' }])).includes('calculated fields depend on each other in a circle: a, b'));
  assert.ok(bad(pg([{ id: 'a', type: 'calculated', label: 'A', formula: '{a}+1' }])).includes('calculated field "a" uses itself'));
  assert.ok(bad(pg([{ id: 'a', type: 'calculated', label: 'A' }])).includes('calculated field "a" needs a formula'));
  assert.ok(bad(pg([{ id: 'a', type: 'select', label: 'A' }])).includes('field "a" needs options'));
  assert.ok(bad(pg([{ id: 'a', type: 'select', label: 'A', options: [{ value: 'x', label: 'X' }, { value: 'x', label: 'Y' }] }])).includes('field "a" has the same option value twice'));
  assert.ok(bad(pg([{ id: 'a', type: 'number', label: 'A', min: 5, max: 1 }])).includes('field "a" has min above max'));
  assert.ok(bad(pg([{ id: 'a', type: 'text', label: 'A', pattern: '(' }])).includes('the pattern of "a" is not a valid pattern'));
  assert.ok(bad(pg([{ id: 'a', type: 'text', label: ' ' }])).includes('field "a" needs a label'));
  assert.ok(bad({ routes: [{ id: 'r', to: { kind: 'webhook', target: 'http://x.example' } }] }).includes('route "r" posts to "http://x.example": webhooks must be https'));
  assert.ok(bad({ routes: [{ id: 'r', to: { kind: 'email', target: 'nobody' } }] }).includes('route "r" sends to "nobody", which is not an email address'));
  assert.ok(bad({ confirmation: 'Hi {nobody}' }).includes('the confirmation names the field "nobody", which does not exist'));
});

test('rules show and require fields, and a hidden field counts as blank in every other rule', () => {
  const young = evaluate(form, { ...adult, age: 15, guardian: 'Bea' });
  assert.deepEqual([young.visible.guardian, young.required.guardian, young.visible.note], [true, true, true]);
  const old = evaluate(form, { ...adult, guardian: 'Bea', note: 'hello' });
  assert.deepEqual([old.visible.guardian, old.required.guardian, old.visible.note], [false, false, false]);
  assert.deepEqual(old.ignored, ['guardian', 'note'], 'the answer of a hidden field is dropped, and the cascade follows');
  assert.equal(old.values.guardian, undefined);
  assert.deepEqual(old.warnings, []);
});

test('calculated fields are worked out here, from visible answers and defaults, and cannot be posted', () => {
  const vip = evaluate(form, { ...adult, kind: 'vip', qty: 3 });
  assert.deepEqual([vip.values.price, vip.values.total], [150, 450]);
  assert.equal(evaluate(form, { ...adult, kind: 'std', qty: undefined }).values.total, 60, 'the default quantity of 1');
  const r = validateForm(form, { ...adult, kind: 'vip', qty: 2, seat: 'front', total: 1 });
  assert.equal(r.ok && r.values.total, 300);
  assert.ok(r.state.ignored.includes('total'));
  const broken: FormDef = { ...form, pages: [{ id: 'p', title: 'P', fields: [{ id: 'q', type: 'integer', label: 'Q' }, { id: 'inv', type: 'calculated', label: 'Inverse', formula: '1/{q}' }] }] };
  const e = evaluate(broken, {});
  assert.equal(e.values.inv, null);
  assert.deepEqual(e.warnings, ['"inv" could not be calculated (#DIV/0!)']);
  assert.equal(evaluate(broken, { q: 4 }).values.inv, 0.25);
});

test('every problem comes back at once, worded with the field labels', () => {
  const r = validateForm(form, { name: '', email: 'nope', age: 200, kind: 'gold', qty: 11, diet: ['veg', 'gf', 'nut'], arrive: '2026-07-04', terms: false });
  assert.deepEqual(probs(r), [
    'name: Full name is needed',
    'email: that does not look like an email address',
    'age: Age must be at most 120',
    'kind: Ticket must be one of: std, vip',
    'qty: How many must be at most 10',
    'diet: Dietary needs can have at most 2 choices',
    'arrive: Arrival must be on or before 2026-06-30',
    'terms: I accept the terms must be ticked',
  ]);
  assert.deepEqual(Object.keys(fieldErrors(r.ok ? [] : r.problems)), ['name', 'email', 'age', 'kind', 'qty', 'diet', 'arrive', 'terms']);
});

test('types are checked: wrong kinds of value, bad choices, duplicates, text where a number goes', () => {
  assert.ok(probs(validateForm(form, { ...adult, age: 'old' })).includes('age: Age must be a number'));
  assert.ok(probs(validateForm(form, { ...adult, age: 3.5 })).includes('age: Age must be a whole number'));
  assert.ok(probs(validateForm(form, { ...adult, diet: 'veg' })).includes('diet: Dietary needs must be a list of choices'));
  assert.ok(probs(validateForm(form, { ...adult, diet: ['veg', 'veg'] })).includes('diet: Dietary needs lists a choice twice'));
  assert.ok(probs(validateForm(form, { ...adult, diet: ['pizza'] })).includes('diet: Dietary needs: "pizza" is not one of the choices'));
  assert.ok(probs(validateForm(form, { ...adult, arrive: '2026-02-30' })).includes('arrive: 2026-02-30 is not a real date'));
  assert.ok(probs(validateForm(form, { ...adult, arrive: '2026-05-31' })).includes('arrive: Arrival must be on or after 2026-06-01'));
  assert.ok(probs(validateForm(form, { ...adult, name: 'x'.repeat(41) })).includes('name: Full name can have at most 40 characters'));
  assert.deepEqual(probs(validateForm(form, { ...adult, surprise: 1 })), ['surprise: surprise is not a field of this form']);
  assert.ok(probs(validateForm(form, { ...adult, terms: 'maybe' })).includes('terms: I accept the terms must be yes or no'));
});

test('required follows the rules: a minor must name a guardian, an adult need not', () => {
  assert.deepEqual(probs(validateForm(form, { ...adult, age: 15 })), ['guardian: Parent or guardian is needed']);
  assert.deepEqual(probs(validateForm(form, { ...adult, age: 15, guardian: '  ' })), ['guardian: Parent or guardian is needed']);
  assert.deepEqual(probs(validateForm(form, { ...adult, age: 15, guardian: 'Bea' })), []);
  assert.deepEqual(probs(validateForm(form, adult)), []);
  assert.deepEqual(probs(validateForm(form, { ...adult, kind: 'vip' })), ['seat: Seat is needed'], 'the VIP page shows for vip');
});

test('cleaned values hold only what is shown, as the right types', () => {
  const r = validateForm(form, { ...adult, age: '16', guardian: ' Bea ', qty: '4', diet: ['veg'], arrive: '2026-06-15', terms: 'on', note: ' hi ' });
  assert.ok(r.ok);
  if (r.ok) assert.deepEqual(r.values, { name: 'Ada Lovelace', email: 'ada@example.com', age: 16, guardian: 'Bea', note: 'hi', kind: 'std', qty: 4, price: 60, total: 240, diet: ['veg'], arrive: '2026-06-15', terms: true });
});

test('answers that start with "=" are text, never formulas', () => {
  const rules: FormDef = { ...form, pages: [{ id: 'p', title: 'P', fields: [{ id: 'name', type: 'text', label: 'Name' }, { id: 'other', type: 'text', label: 'Other', visibleWhen: '{name}="=1/0"' }, { id: 'calc', type: 'calculated', label: 'Calc', formula: 'LEN({name})' }] }], routes: [] };
  const s = evaluate(rules, { name: '=1/0', other: 'shown' });
  assert.equal(s.visible.other, true, 'the text "=1/0" equals itself');
  assert.equal(s.values.calc, 4);
  assert.deepEqual(s.warnings, []);
  const r = validateForm(rules, { name: '=SUM(1,2)' });
  assert.equal(r.ok && r.values.name, '=SUM(1,2)');
});

test('pages are walked in order, skipping any that have nothing to show', () => {
  assert.equal(nextPage(form, adult)!.id, 'about');
  assert.equal(nextPage(form, adult, 'about')!.id, 'tickets');
  assert.equal(nextPage(form, adult, 'tickets'), null, 'a standard ticket has no VIP page');
  assert.equal(nextPage(form, { ...adult, kind: 'vip' }, 'tickets')!.id, 'vip');
  assert.equal(previousPage(form, { ...adult, kind: 'vip' }, 'vip')!.id, 'tickets');
  assert.equal(previousPage(form, adult, 'about'), null);
  assert.deepEqual(visiblePages(form, adult).map((p) => p.id), ['about', 'tickets']);
  assert.throws(() => nextPage(form, adult, 'zzz'), FormError);
});

test('a page can be checked on its own as people move through', () => {
  const partial = { name: 'Ada', email: 'ada@example.com', age: 36 };
  assert.deepEqual(probs(validatePage(form, partial, 'about')), []);
  assert.deepEqual(probs(validatePage(form, partial, 'tickets')), ['kind: Ticket is needed', 'terms: I accept the terms must be ticked']);
  assert.deepEqual(probs(validatePage(form, { ...partial, age: 15 }, 'about')), ['guardian: Parent or guardian is needed']);
  assert.throws(() => validatePage(form, partial, 'nope'), FormError);
});

test('submissions are routed by rule, to every match or the first, else the fallback', () => {
  const big = validateForm(form, { ...adult, kind: 'vip', qty: 5, seat: 'back' });
  assert.ok(big.ok);
  if (big.ok) assert.deepEqual(route(form, big.values).map((d) => [d.route, d.kind, d.target]), [['big', 'email', 'sales@example.com'], ['vip', 'webhook', 'https://hooks.example.com/vip']]);
  const small = validateForm(form, adult);
  if (small.ok) assert.deepEqual(route(form, small.values).map((d) => d.route), ['rest']);
  if (big.ok) assert.deepEqual(route({ ...form, routing: 'first' }, big.values).map((d) => d.route), ['big']);
  assert.deepEqual(route({ ...form, routes: [] }, {}), []);
});

test('submit checks, routes and fills in the confirmation, or returns the problems for the fields', () => {
  const ok = submit(form, { ...adult, kind: 'vip', qty: 2, seat: 'front' });
  assert.ok(ok.ok);
  if (ok.ok) {
    assert.equal(ok.submission.confirmation, 'Thanks Ada Lovelace! Your total is 300.');
    assert.deepEqual(ok.submission.destinations.map((d) => d.route), ['vip']);
  }
  const no = submit(form, { ...adult, email: '' });
  assert.ok(!no.ok);
  if (!no.ok) assert.deepEqual(fieldErrors(no.problems), { email: 'Email is needed' });
  assert.equal(confirmation({ ...form, confirmation: undefined as never }, {}), 'Thank you. Your answers were received.');
  assert.equal(confirmation(form, { name: 'Bo' }), 'Thanks Bo! Your total is .');
});

test('prefill reads each query parameter by its field type and ignores what does not fit', () => {
  const p = prefill(form, { name: 'Ada', age: '36', kind: 'vip', diet: 'veg, gf', terms: '1', arrive: '2026-06-10', email: 'a@b.test', total: '1', utm_source: 'x' });
  assert.deepEqual(p.answers, { name: 'Ada', age: 36, kind: 'vip', diet: ['veg', 'gf'], terms: true, arrive: '2026-06-10', email: 'a@b.test' });
  assert.deepEqual(p.ignored, ['total', 'utm_source'], 'a calculated field and unknown names are not filled');
  const bad = prefill(form, { age: 'old', kind: 'gold', diet: 'pizza', terms: 'maybe', arrive: '2026-13-01', email: 'nope' });
  assert.deepEqual(bad.answers, {});
  assert.deepEqual(bad.ignored, ['age', 'arrive', 'diet', 'email', 'kind', 'terms']);
  const off: FormDef = { ...form, pages: [{ id: 'p', title: 'P', fields: [{ id: 'src', type: 'hidden', label: 'Source', prefill: 'utm_source' }, { id: 'secret', type: 'text', label: 'S', prefill: false }] }] };
  assert.deepEqual(prefill(off, { utm_source: 'news', secret: 'x' }), { answers: { src: 'news' }, ignored: ['secret'] });
});

test('a pattern rule checks text with its own message, and hidden fields keep prefilled values', () => {
  const f: FormDef = { ...form, routes: [], pages: [{ id: 'p', title: 'P', fields: [{ id: 'code', type: 'text', label: 'Code', pattern: '^[A-Z]{3}-\\d{4}$', patternMessage: 'a code looks like ABC-1234' }, { id: 'src', type: 'hidden', label: 'Source' }] }] };
  assert.deepEqual(probs(validateForm(f, { code: 'abc' })), ['code: a code looks like ABC-1234']);
  const ok = validateForm(f, { code: 'ABC-1234', src: 'newsletter' });
  assert.equal(ok.ok && ok.values.src, 'newsletter');
});
