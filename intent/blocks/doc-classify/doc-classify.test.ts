import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRule, Classifier, checkRegex, checkTemplate, matches, renderPath, safeSegment, validateRule } from './index.ts';
import type { Document, Entity, MatchRule } from './index.ts';

const doc = (content: string, o: Partial<Document> = {}): Document => ({ title: 'scan 001', content, created: '2024-03-17', ...o });
const m = (rule: MatchRule, text: string) => matches(rule, text);

test('any: one of the words, whole words only, ignoring case and accents', () => {
  assert.equal(m({ algorithm: 'any', pattern: 'invoice rechnung' }, 'Your RECHNUNG for March').matched, true);
  assert.equal(m({ algorithm: 'any', pattern: 'invoice' }, 'invoices attached').matched, false, 'a word inside another word is not a match');
  assert.equal(m({ algorithm: 'any', pattern: 'cafe' }, 'Café menu').matched, true);
  assert.equal(m({ algorithm: 'any', pattern: 'Cafe', insensitive: false }, 'cafe menu').matched, false);
  assert.equal(m({ algorithm: 'any', pattern: 'a b' }, 'a b b a').strength, 2);
});

test('all: every word must be there, in any order', () => {
  assert.equal(m({ algorithm: 'all', pattern: 'electric bill' }, 'the bill for electric service').matched, true);
  assert.equal(m({ algorithm: 'all', pattern: 'electric bill' }, 'the bill for gas').matched, false);
});

test('literal: the exact phrase, across line breaks and punctuation', () => {
  assert.equal(m({ algorithm: 'literal', pattern: 'Amount due' }, 'Total\nAmount   due: $5').matched, true);
  assert.equal(m({ algorithm: 'literal', pattern: 'amount due' }, 'due amount').matched, false);
  assert.equal(m({ algorithm: 'literal', pattern: 'amount due' }, 'discount amount duelling').matched, false);
});

test('regex: matches and says where; case option; bad patterns are refused when the rule is made', () => {
  const r = m({ algorithm: 'regex', pattern: 'INV-\\d{4,}' }, 'Ref inv-20431 today');
  assert.equal(r.matched, true);
  assert.match(r.why, /at "inv-20431"/);
  assert.equal(m({ algorithm: 'regex', pattern: 'INV-\\d+', insensitive: false }, 'inv-1').matched, false);
  assert.throws(() => validateRule({ algorithm: 'regex', pattern: '([a' }), /not a valid regular expression/);
  assert.throws(() => validateRule({ algorithm: 'regex', pattern: '' }), /needs a pattern/);
});

test('regular expressions that can run for minutes are refused: nested repetition, repeated alternation, backreferences, look-behind', () => {
  for (const bad of ['(a+)+$', '(a*)*b', '(a|aa)+c', '(x+x+)+y', '((ab)+)*', '(.*a){3,}', '(a)\\1', '(?<=a)b']) assert.throws(() => checkRegex(bad), BadRule, bad);
  for (const ok of ['^INV-\\d{4,}$', '(foo|bar) \\d+', '[a-z]+@[a-z]+\\.com', '(?:ab)?c', '\\(a+\\)+']) assert.doesNotThrow(() => checkRegex(ok), ok);
  assert.throws(() => checkRegex('a'.repeat(201)), /1 to 200/);
  const start = Date.now();
  assert.equal(m({ algorithm: 'regex', pattern: '^(a|b)\\d$' }, 'a'.repeat(100_000) + '!').matched, false);
  assert.ok(Date.now() - start < 1000);
});

test('fuzzy: forgives scanning errors, and says how close it was', () => {
  const rule: MatchRule = { algorithm: 'fuzzy', pattern: 'Stadtwerke Dayton' };
  const r = m(rule, 'Rechnung von Stadtwerke Dayt0n vom Januar');
  assert.equal(r.matched, true);
  assert.match(r.why, /^is 9\d% like "Stadtwerke Dayton"/);
  assert.equal(m(rule, 'Rechnung von Stadtwerke Berlin').matched, false);
  assert.equal(m({ ...rule, threshold: 0.5 }, 'Stadtwerke Berlin').matched, true);
  assert.throws(() => validateRule({ ...rule, threshold: 0 }), /threshold/);
  assert.throws(() => validateRule({ algorithm: 'wizard' as never }), /not a matching algorithm/);
});

const correspondents: Entity[] = [
  { id: 'c-pg', name: 'Power & Gas Co', rule: { algorithm: 'literal', pattern: 'power & gas' } },
  { id: 'c-bank', name: 'First Bank', rule: { algorithm: 'any', pattern: 'firstbank first-bank' } },
  { id: 'c-tax', name: 'Tax Office', rule: { algorithm: 'all', pattern: 'tax office' } },
];
const types: Entity[] = [{ id: 't-inv', name: 'Invoice', rule: { algorithm: 'any', pattern: 'invoice' } }, { id: 't-stmt', name: 'Statement', rule: { algorithm: 'any', pattern: 'statement' } }];
const tags: Entity[] = [{ id: 'g-paid', name: 'Paid', rule: { algorithm: 'regex', pattern: 'paid in full' } }, { id: 'g-inbox', name: 'Inbox', rule: { algorithm: 'any', pattern: 'scan' }, inbox: true }];
const paths: Entity[] = [{ id: 'p-fin', name: 'Finance', rule: { algorithm: 'any', pattern: 'invoice statement' }, template: '{correspondent}/{created_year}/{title}' }];

test('a document is filed with a reason for each choice', () => {
  const c = new Classifier({ correspondents, types, tags, storagePaths: paths });
  const d = c.classify(doc('Power & Gas invoice, paid in full. Thank you'));
  assert.equal(d.correspondent, 'c-pg');
  assert.equal(d.type, 't-inv');
  assert.equal(d.storagePath, 'p-fin');
  assert.deepEqual(d.tags, ['g-paid', 'g-inbox']);
  assert.deepEqual(d.ambiguous, []);
  assert.deepEqual(d.reasons.map((r) => [r.field, r.entity]), [['correspondent', 'Power & Gas Co'], ['document type', 'Invoice'], ['storage path', 'Finance'], ['tag', 'Paid'], ['tag', 'Inbox']]);
  assert.match(d.reasons[0]!.why, /contains the phrase "power & gas"/);
});

test('the stronger match wins; equally strong rules leave the field empty and say so', () => {
  const es: Entity[] = [{ id: 'a', name: 'Acme', rule: { algorithm: 'any', pattern: 'acme' } }, { id: 'b', name: 'Acme Holdings', rule: { algorithm: 'literal', pattern: 'acme holdings' } }];
  const c = new Classifier({ correspondents: es });
  assert.equal(c.classify(doc('Acme Holdings Ltd')).correspondent, 'b', 'a phrase beats one word');
  const tie: Entity[] = [{ id: 'x', name: 'X Corp', rule: { algorithm: 'any', pattern: 'invoice' } }, { id: 'y', name: 'Y Corp', rule: { algorithm: 'any', pattern: 'invoice' } }];
  const d = new Classifier({ correspondents: tie }).classify(doc('an invoice'));
  assert.equal(d.correspondent, undefined);
  assert.deepEqual(d.ambiguous, [{ field: 'correspondent', candidates: ['X Corp', 'Y Corp'] }]);
});

test('entities must be unique and valid when the classifier is made', () => {
  assert.throws(() => new Classifier({ tags: [{ id: 'a', name: 'A', rule: { algorithm: 'any', pattern: 'x' } }, { id: 'a', name: 'B', rule: { algorithm: 'any', pattern: 'y' } }] }), /same id|two entities have the id a/);
  assert.throws(() => new Classifier({ tags: [{ id: 'a', name: 'A', rule: { algorithm: 'regex', pattern: '(a+)+' } }] }), /nested repetition/);
  assert.throws(() => new Classifier({ storagePaths: [{ id: 'p', name: 'P', rule: { algorithm: 'none' }, template: '{secret}/x' }] }), /not a field/);
});

const learnedEntities = {
  correspondents: [{ id: 'c-a', name: 'Alpha Utilities', rule: { algorithm: 'auto' } }, { id: 'c-b', name: 'Beta Insurance', rule: { algorithm: 'auto' } }] as Entity[],
  tags: [{ id: 'g-home', name: 'Home', rule: { algorithm: 'auto' } }] as Entity[],
};
const examples = [
  ...Array.from({ length: 4 }, (_, i) => ({ doc: doc(`kilowatt hours meter reading electricity usage billing period ${i}`), correspondent: 'c-a', tags: ['g-home'] })),
  ...Array.from({ length: 4 }, (_, i) => ({ doc: doc(`premium policy coverage deductible claim insured liability ${i}`), correspondent: 'c-b', tags: [] as string[] })),
];

test('auto learns the correspondent from filed documents and explains how sure it is', () => {
  const c = new Classifier(learnedEntities);
  c.train(examples);
  assert.equal(c.examples, 8);
  const d = c.classify(doc('your electricity usage this billing period in kilowatt hours'));
  assert.equal(d.correspondent, 'c-a');
  assert.match(d.reasons[0]!.why, /^learned from 4 filed documents, \d+% sure$/);
  assert.equal(c.classify(doc('policy coverage and your deductible')).correspondent, 'c-b');
});

test('auto learns tags one by one, and stays quiet when unsure or untrained', () => {
  const c = new Classifier(learnedEntities);
  assert.deepEqual(c.classify(doc('electricity usage')).tags, [], 'nothing learned yet');
  c.train(examples);
  assert.deepEqual(c.classify(doc('electricity meter reading kilowatt')).tags, ['g-home']);
  assert.deepEqual(c.classify(doc('policy deductible claim')).tags, []);
  const few = new Classifier(learnedEntities);
  few.train(examples.slice(0, 1));
  assert.equal(few.classify(doc('electricity usage kilowatt')).correspondent, undefined, 'one example is not enough');
});

test('a rule match beats the learned guess', () => {
  const c = new Classifier({ correspondents: [{ id: 'c-a', name: 'Alpha', rule: { algorithm: 'auto' } }, { id: 'c-b', name: 'Beta', rule: { algorithm: 'literal', pattern: 'beta insurance' } }] });
  c.train(examples);
  assert.equal(c.classify(doc('Beta Insurance: electricity usage kilowatt hours meter')).correspondent, 'c-b');
});

test('storage path templates fill from the decision and the document', () => {
  const c = new Classifier({ correspondents, types, storagePaths: paths });
  const d = doc('Power & Gas invoice', { title: 'March bill', created: '2024-03-17', asn: 42 });
  assert.equal(c.pathFor(d, c.classify(d)), 'Power & Gas Co/2024/March bill');
  const plain = new Classifier({ correspondents, types });
  const decision = plain.classify(d);
  assert.equal(plain.pathFor(d, decision, '{document_type}/{created_year}-{created_month}-{created_day} {title} ASN{asn}'), 'Invoice/2024-03-17 March bill ASN0000042');
  const none = plain.classify({ title: 'T', content: 'nothing here' });
  assert.equal(plain.pathFor({ title: 'T', content: 'x' }, none, '{correspondent}/{created_year}/{title}'), 'none/none/T');
});

test('names that try to climb out of the folder or break a file system are made harmless', () => {
  assert.equal(safeSegment('../../etc/passwd'), '-..-etc-passwd', 'separators become dashes, so it is one harmless name');
  assert.equal(safeSegment('..'), 'none');
  assert.equal(safeSegment('a/b\\c:d*e?'), 'a-b-c-d-e-');
  assert.equal(safeSegment('CON'), '_CON');
  assert.equal(safeSegment('nul.txt'), '_nul.txt');
  assert.equal(safeSegment('  trailing dots... '), 'trailing dots');
  assert.equal(safeSegment('a\u0000b‮c'), 'abc');
  assert.equal(safeSegment('x'.repeat(300)).length, 100);
  assert.equal(renderPath('{correspondent}/{title}', { correspondent: '../..', title: '/etc/x' }), '-/-etc-x');
  assert.equal(renderPath('/a//b/../c', {}), 'a/b/none/c', 'a dot-dot segment becomes a plain name');
  assert.ok(!renderPath('../x/{title}', { title: 'y' }).includes('..'));
});

test('template checks: unknown fields, unpaired braces, length', () => {
  assert.doesNotThrow(() => checkTemplate('{correspondent}/{created_year}/{title}'));
  assert.throws(() => checkTemplate('{password}/x'), /not a field/);
  assert.throws(() => checkTemplate('{title'), /pair up/);
  assert.throws(() => checkTemplate('title}'), /pair up/);
  assert.throws(() => checkTemplate('{title}'.repeat(60)), /300/);
});

test('huge documents are matched on a bounded part, quickly', () => {
  const big = 'filler '.repeat(200_000) + 'needle';
  const start = Date.now();
  assert.equal(m({ algorithm: 'any', pattern: 'needle' }, big).matched, false, 'beyond the cap nothing is read');
  assert.equal(m({ algorithm: 'any', pattern: 'filler' }, big).matched, true);
  assert.ok(Date.now() - start < 2000);
});
