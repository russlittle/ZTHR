import { describe, expect, it } from 'vitest';
import { CLASSES, DocStore, atLeast, collectionClass, erd, field, rank, unclassified, type CollectionDef } from '../src/index.js';

// Verifies docs/blocks/store.md
describe('document store', () => {
  it('puts, gets, lists in order, and removes', () => {
    const s = new DocStore();
    s.put('notes', 'n1', 'ana', { t: 1 });
    s.put('notes', 'n2', 'ana', { t: 2 });
    s.put('notes', 'n3', 'ben', { t: 3 });
    expect(s.get('notes', 'n1')).toEqual({ t: 1 });
    expect(s.get('notes', 'nope')).toBeUndefined();
    expect(s.list('notes', 'ana')).toEqual([{ t: 1 }, { t: 2 }]);
    s.put('notes', 'n1', 'ana', { t: 9 });
    expect(s.get('notes', 'n1')).toEqual({ t: 9 });
    s.remove('notes', 'n2');
    expect(s.list('notes', 'ana')).toEqual([{ t: 9 }]);
  });
  it('exports, counts and deletes one owner\'s whole record and nobody else\'s', () => {
    const s = new DocStore();
    s.put('b', '1', 'ana', { x: 1 });
    s.put('a', '2', 'ana', { x: 2 });
    s.put('a', '3', 'ben', { x: 3 });
    expect(s.exportStudent('ana')).toEqual({ a: [{ x: 2 }], b: [{ x: 1 }] });
    expect(s.countFor('ana')).toBe(2);
    expect(s.deleteStudent('ana')).toBe(2);
    expect(s.countFor('ana')).toBe(0);
    expect(s.exportStudent('ana')).toEqual({});
    expect(s.countFor('ben')).toBe(1);
  });
  it('dumps every document as text, one per line', () => {
    const s = new DocStore();
    s.put('a', '1', 'x', { v: 'one' });
    s.put('b', '2', 'y', { v: 'two' });
    expect(s.dump()).toBe('a\t{"v":"one"}\nb\t{"v":"two"}');
  });
});

describe('classification', () => {
  const cs: CollectionDef[] = [
    { name: 'people', purpose: '', key: 'id', fields: [field('id', 'string', 'internal'), field('name', 'string', 'personal', 'chosen'), field('income', 'number', 'sensitive', undefined, true)], relations: [['visits', 'makes', '||--o{'], ['ghosts', 'haunts', '||--||']] },
    { name: 'visits', purpose: '', key: 'id', fields: [field('id', 'string', 'internal'), { name: 'note', type: 'text' }] },
  ];
  it('orders classes from public to secret', () => {
    expect(CLASSES).toEqual(['public', 'internal', 'personal', 'sensitive', 'secret']);
    expect(rank('public')).toBe(0);
    expect(rank('secret')).toBe(4);
    expect(atLeast('sensitive', 'personal')).toBe(true);
    expect(atLeast('personal', 'personal')).toBe(true);
    expect(atLeast('internal', 'personal')).toBe(false);
  });
  it('field() builds a classified field', () => {
    expect(field('n', 'string', 'personal')).toEqual({ name: 'n', type: 'string', cls: 'personal', note: undefined, optional: false });
    expect(field('n', 'string', 'secret', 'hash', true).optional).toBe(true);
  });
  it('a collection is as sensitive as its most sensitive field', () => {
    expect(collectionClass(cs[0]!)).toBe('sensitive');
    expect(collectionClass(cs[1]!)).toBe('internal');
    expect(collectionClass({ name: 'x', purpose: '', key: 'id', fields: [] })).toBe('public');
  });
  it('names every unclassified field', () => {
    expect(unclassified(cs)).toEqual(['visits.note']);
    expect(unclassified([{ name: 'x', purpose: '', key: 'k', fields: [{ name: 'k', type: 's', cls: 'bogus' as never }] }])).toEqual(['x.k']);
  });
  it('draws an ERD with keys, notes or classes, and only relations to declared collections', () => {
    const d = erd(cs);
    expect(d.split('\n')[0]).toBe('erDiagram');
    expect(d).toContain('  people {\n    string id PK\n    string name "chosen"\n    number income\n  }');
    expect(d).toContain('people ||--o{ visits : "makes"');
    expect(d).not.toContain('ghosts');
    const c = erd(cs, { showClass: true });
    expect(c).toContain('string name "personal"');
    expect(c).toContain('text note\n');
    expect(erd([{ name: 'a-b', purpose: '', key: 'k', fields: [field('k', 'date or time', 'internal'), field('xs', 'string[]', 'internal', 'say "hi"')] }])).toContain('  a_b {\n    date k PK\n    string_list xs "say \'hi\'"\n  }');
  });
});
