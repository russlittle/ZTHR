import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Fake, TEST_CARDS, factory, looksFake, rng } from './index.ts';

test('the same seed gives the same data; a different seed differs', () => {
  const a = new Fake(42);
  const b = new Fake(42);
  const run = (f: Fake) => [f.name().full, f.email(), f.phone(), f.int(1, 100), f.filename()];
  assert.deepEqual(run(a), run(b));
  assert.notDeepEqual(run(new Fake(42)), run(new Fake(43)));
});

test('everything produced is in ranges reserved for fiction, and the guard spots real-looking values', () => {
  const f = new Fake(7);
  for (let i = 0; i < 500; i++) {
    const n = f.name();
    const v = { email: f.email(n.full), phone: f.phone(f.bool() ? 'US' : 'GB'), card: f.pick(Object.values(TEST_CARDS)) };
    assert.ok(looksFake(v), JSON.stringify(v));
    assert.match(v.email, /^[a-z0-9.]+@example\.(com|org|net)$/);
  }
  assert.equal(looksFake({ email: 'ana@gmail.com' }), false);
  assert.equal(looksFake({ phone: '+19375551234' }), false);
  assert.equal(looksFake({ card: '4111111111111112' }), false);
  const d = f.date('2026-01-01', '2026-02-01');
  assert.ok(d >= new Date('2026-01-01') && d < new Date('2026-02-01'));
});

test('factories take overrides and build datasets to a shape', () => {
  const f = new Fake(1);
  const account = factory((fk, i) => ({ id: fk.id('acct'), n: i, name: fk.name().full, plan: fk.pick(['free', 'pro']) }));
  const file = factory((fk) => ({ id: fk.id('file'), name: fk.filename(), size: fk.int(1, 5_000_000) }));
  const data = Array.from({ length: 3 }, () => ({ ...account(f), files: Array.from({ length: 4 }, () => file(f)) }));
  assert.deepEqual(data.map((d) => d.n), [1, 2, 3]);
  assert.equal(new Set(data.flatMap((d) => d.files.map((x) => x.id))).size, 12);
  assert.equal(account(f, { plan: 'enterprise' }).plan, 'enterprise');
});

test('a factory gives the same records for the same seed, whatever ran before it', () => {
  const person = factory((fk, i) => ({ n: i, id: fk.id('p'), name: fk.name().full }));
  const run = () => {
    const f = new Fake(5);
    return [person(f), person(f)];
  };
  assert.deepEqual(run(), run());
});

test('an email built from a name with no Latin letters is still a valid address', () => {
  const f = new Fake(3);
  for (const n of ['王芳', 'Ødegård', 'Σοφία']) assert.match(f.email(n), /^[a-z0-9]+(\.[a-z0-9]+)*@example\.(com|org|net)$/, n);
});

const fakeWith = (r: () => number): Fake => {
  const f = new Fake(1);
  Object.defineProperty(f, 'r', { value: r });
  return f;
};
const LOW = () => 0;
const HIGH = () => 1 - 2 ** -32;

test('rng gives the same well-spread numbers in [0, 1) for a seed, on every machine', () => {
  const r = rng(1);
  assert.deepEqual([r(), r(), r()], [0.6270739405881613, 0.002735721180215478, 0.5274470399599522]);
  const s = rng(12345);
  let sum = 0;
  for (let i = 0; i < 4000; i++) {
    const x = s();
    assert.ok(x >= 0 && x < 1);
    sum += x;
  }
  assert.ok(Math.abs(sum / 4000 - 0.5) < 0.03);
  assert.equal(rng(2 ** 32 + 1)(), rng(1)());
});

test('int, pick and bool cover their whole range and respect the edges', () => {
  const f = new Fake(9);
  const seen = new Set<number>();
  for (let i = 0; i < 400; i++) seen.add(f.int(3, 6));
  assert.deepEqual([...seen].sort(), [3, 4, 5, 6]);
  assert.equal(f.int(7, 7), 7);
  assert.equal(fakeWith(LOW).int(3, 6), 3);
  assert.equal(fakeWith(HIGH).int(3, 6), 6);
  const picked = new Set<string>();
  for (let i = 0; i < 400; i++) picked.add(f.pick(['a', 'b', 'c', 'd']));
  assert.deepEqual([...picked].sort(), ['a', 'b', 'c', 'd']);
  assert.equal(fakeWith(LOW).pick(['a', 'b', 'c']), 'a');
  assert.equal(fakeWith(HIGH).pick(['a', 'b', 'c']), 'c');
  // bool(p) is true with probability p: never at 0, always at 1, and strictly below p.
  assert.equal(fakeWith(LOW).bool(0), false);
  assert.equal(fakeWith(HIGH).bool(1), true);
  assert.equal(fakeWith(() => 0.5).bool(0.5), false);
  assert.equal(fakeWith(() => 0.49).bool(0.5), true);
  assert.equal(fakeWith(() => 0.51).bool(0.5), false);
  assert.equal(fakeWith(() => 0.3).bool(), true);
  assert.equal(fakeWith(() => 0.7).bool(), false);
  let trues = 0;
  for (let i = 0; i < 2000; i++) if (f.bool(0.25)) trues++;
  assert.ok(trues > 400 && trues < 600, String(trues));
});

test('ids count up per Fake in base 36, padded to four characters, with the given prefix', () => {
  const f = new Fake(1);
  assert.deepEqual([f.id(), f.id('acct'), f.id('x')], ['id_0001', 'acct_0002', 'x_0003']);
  for (let i = 0; i < 32; i++) f.id();
  assert.equal(f.id('z'), 'z_0010');
  assert.equal(new Fake(2).id(), 'id_0001');
});

test('names are given and family parts drawn from a wide mix, joined as full', () => {
  const f = new Fake(11);
  const given = new Set<string>();
  const family = new Set<string>();
  for (let i = 0; i < 6000; i++) {
    const n = f.name();
    assert.deepEqual(Object.keys(n), ['given', 'family', 'full']);
    assert.equal(n.full, `${n.given} ${n.family}`);
    given.add(n.given);
    family.add(n.family);
  }
  assert.deepEqual([...given].sort(), ['Ana', 'Aroha', 'Ben', 'Björn', 'Chioma', 'Dmitri', 'Elif', 'Farah', 'Gabriel', 'Hana', 'Ifeoma', 'Jae-won', 'Kofi', 'Lucía', 'Mateo', 'Nadia', 'Oluwaseun', 'Priya', 'Quang', 'Rania', 'Siobhán', 'Sione', 'Thandiwe', 'Tomás', 'Uma', 'Valentina', 'Wei', 'Ximena', 'Yusuf', 'Zainab'].sort());
  assert.deepEqual([...family].sort(), ['Abebe', 'Chen', 'Cohen', 'Fernández', 'García', 'Haddad', 'Ivanova', 'Khan', 'Kim', 'Kowalski', 'Lindqvist', 'Mbeki', 'Mensah', 'Müller', 'Ngata', 'Nguyen', "O'Brien", 'Okafor', 'Patel', 'Rossi', 'Silva', 'Smith', 'Tanaka', 'Yılmaz'].sort());
  assert.deepEqual(fakeWith(LOW).name(), { given: 'Ana', family: 'Okafor', full: 'Ana Okafor' });
});

test('an email local part is the lowercased, accent-stripped name with single dots, then a number and a reserved domain', () => {
  const f = fakeWith(LOW);
  assert.equal(f.email('Ana'), 'ana.1@example.com');
  assert.equal(f.email('Zoë Müller'), 'zoe.muller.1@example.com');
  assert.equal(f.email('Jae-won  Kim'), 'jae.won.kim.1@example.com');
  assert.equal(f.email('--Ana--'), 'ana.1@example.com');
  assert.equal(f.email("O'Brien"), 'o.brien.1@example.com');
  assert.equal(f.email('ÅNA'), 'ana.1@example.com');
  assert.equal(f.email(''), 'person.1@example.com');
  assert.equal(f.email('王芳'), 'person.1@example.com');
  assert.equal(f.email(), 'ana.1@example.com');
  assert.equal(fakeWith(HIGH).email('Ana'), 'ana.999@example.net');
  const g = new Fake(21);
  const domains = new Set<string>();
  for (let i = 0; i < 100; i++) domains.add(g.email('Ana').split('@')[1]!);
  assert.deepEqual([...domains].sort(), ['example.com', 'example.net', 'example.org']);
});

test('phone numbers are US or UK fiction ranges, US by default, with the exact digits at both ends of the range', () => {
  assert.equal(fakeWith(LOW).phone(), '+12125550100');
  assert.equal(fakeWith(LOW).phone('US'), '+12125550100');
  assert.equal(fakeWith(HIGH).phone(), '+19375550199');
  assert.equal(fakeWith(LOW).phone('GB'), '+447700900000');
  assert.equal(fakeWith(HIGH).phone('GB'), '+447700900999');
  const f = new Fake(4);
  const areas = new Set<string>();
  for (let i = 0; i < 300; i++) {
    const p = f.phone();
    assert.match(p, /^\+1\d{3}55501\d{2}$/);
    areas.add(p.slice(2, 5));
  }
  assert.deepEqual([...areas].sort(), ['212', '312', '415', '937']);
  assert.equal(fakeWith(() => 0.05).phone('GB'), '+447700900050');
  assert.equal(fakeWith(() => 0.05).phone(), '+12125550105');
});

test('dates fall from the start up to, not including, the end, spread evenly', () => {
  assert.equal(fakeWith(LOW).date('2026-01-01', '2026-02-01').toISOString(), '2026-01-01T00:00:00.000Z');
  assert.equal(fakeWith(() => 0.5).date('2026-01-01T00:00:00Z', '2026-01-03T00:00:00Z').toISOString(), '2026-01-02T00:00:00.000Z');
  assert.ok(fakeWith(HIGH).date('2026-01-01', '2026-02-01') < new Date('2026-02-01'));
});

test('sentences have the given number of words, a capital first letter and a full stop', () => {
  assert.equal(fakeWith(LOW).sentence(3), 'Plan plan plan.');
  assert.equal(fakeWith(LOW).sentence(1), 'Plan.');
  assert.equal(fakeWith(LOW).sentence(), 'Plan plan plan plan plan plan plan plan.');
  assert.equal(fakeWith(HIGH).sentence(2), 'Review review.');
  const f = new Fake(8);
  const words = new Set<string>();
  for (let i = 0; i < 400; i++) for (const w of f.sentence(5).slice(0, -1).toLowerCase().split(' ')) words.add(w);
  assert.deepEqual([...words].sort(), ['agenda', 'brief', 'budget', 'contract', 'draft', 'invoice', 'minutes', 'notes', 'photos', 'plan', 'report', 'review', 'roadmap', 'survey']);
});

test('filenames are a word, a year from 2019 to 2026 and one of six extensions', () => {
  assert.equal(fakeWith(LOW).filename(), 'plan-2019.pdf');
  assert.equal(fakeWith(HIGH).filename(), 'review-2026.txt');
  const f = new Fake(2);
  const exts = new Set<string>();
  const years = new Set<number>();
  for (let i = 0; i < 600; i++) {
    const m = /^([a-z]+)-(\d{4})\.([a-z]+)$/.exec(f.filename());
    assert.ok(m);
    exts.add(m[3]!);
    years.add(Number(m[2]));
  }
  assert.deepEqual([...exts].sort(), ['docx', 'jpg', 'pdf', 'png', 'txt', 'xlsx']);
  assert.deepEqual([...years].sort(), [2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026]);
});

test('the guard accepts only whole numbers in the reserved ranges, not ones that merely contain them', () => {
  assert.equal(looksFake({ phone: '+12125550101' }), true);
  assert.equal(looksFake({ phone: '+447700900123' }), true);
  assert.equal(looksFake({ phone: 'x+12125550101' }), false);
  assert.equal(looksFake({ phone: '+12125550101x' }), false);
  assert.equal(looksFake({ phone: '+121255501012' }), false);
  assert.equal(looksFake({ phone: 'x+447700900123' }), false);
  assert.equal(looksFake({ phone: '+4477009001234' }), false);
  assert.equal(looksFake({ phone: '+447700900123x' }), false);
  assert.equal(looksFake({ email: 'ana@example.com' }), true);
  assert.equal(looksFake({ email: 'ana@example.com.evil.io' }), false);
  assert.equal(looksFake({ email: 'ana@notexample.com' }), false);
  assert.equal(looksFake({}), true);
});
