/** Fuzz: phone numbers and addresses (blocks/contact phone, formatAddress, checkAddress). */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FORMATS, PHONE, checkAddress, formatAddress, phone, type Address } from '../../blocks/contact/index.ts';
import { forAll, type Rand } from './harness.ts';

const COUNTRIES = [...Object.keys(PHONE), 'ZZ', '', 'us', '__proto__', 'constructor', 'toString'];
const SEP = [' ', '-', '.', '(', ')', '/', '  ', '\t', ' ', '–', ''];

/** What people type: digits in groups, prefixes, brackets, extensions, stray symbols. */
const typed = (r: Rand): string => {
  const prefix = r.pick(['', '', '+', '00', '+44 (0)', '0', '1-', '+1 ', '011 ', '(0)', '+0', '++', ' + ']);
  const groups = r.array(1, 6, () => String(r.int(0, 10 ** r.int(1, 4) - 1)).padStart(r.int(1, 4), '0'));
  const ext = r.pick(['', '', ' ext. 12', 'x9', ' x 3', ' EXT 7', ' ext']);
  const noise = r.bool(0.1) ? r.pick(['#', '*', ',', ';', 'p', 'w', '😀', '１', '٣', '​']) : '';
  return prefix + groups.join(r.pick(SEP)) + noise + ext;
};

test('phone() output, when it returns, is always ^\\+\\d{8,15}$ (5000 cases)', async () => {
  await forAll('phone format', {
    cases: 5000,
    gen: (r) => ({ typed: r.bool(0.9) ? typed(r) : r.text(0, 20), country: r.pick(COUNTRIES) }),
    shrink: () => [],
    check: ({ typed: t, country }) => {
      let out: string;
      try {
        out = phone(t, country);
      } catch (e) {
        assert.ok(e instanceof Error);
        return;
      }
      assert.match(out, /^\+\d{8,15}$/);
      // E.164 is a fixed point: reading the output again, from any country, gives it back.
      assert.equal(phone(out, 'US'), out);
      assert.equal(phone(out, 'ZZ'), out);
      if (!/^\s*(\+|00)/.test(t.replace(/[^\d+]/g, '')) && Object.hasOwn(PHONE, country)) assert.ok(out.startsWith(`+${PHONE[country]!.cc}`), `national number for ${country} came back as ${out}`);
    },
  });
});

test('a number containing digits from other scripts (１, ٣, ४) is refused, not read with those digits dropped (500 cases)', { todo: 'phone() strips everything but ASCII digits, so full-width or Arabic-Indic digits are silently dropped and the rest is accepted as a different, shorter number' }, async () => {
  await forAll('phone non-ASCII digits', {
    cases: 500,
    gen: (r) => {
      const n = `(937) 555-01${r.int(10, 99)}`;
      const at = r.int(0, n.length);
      return n.slice(0, at) + r.pick(['１', '٣', '४', '๕', '۷']) + n.slice(at);
    },
    shrink: () => [],
    check: (t) => assert.throws(() => phone(t, 'US')),
  });
});

const LINE = ['1 Main St', '  Flat 2  ', '', '   ', '{city}', '$&', '$1', 'Rue de l’Église', '東京都', 'PO Box 5', '-', ',', '〒'];

test('formatAddress: no empty lines, every street line kept, values inserted literally, the country added when sent from elsewhere (2000 cases)', async () => {
  await forAll('address format', {
    cases: 2000,
    gen: (r): { a: Address; from?: string } => {
      const country = r.pick([...Object.keys(FORMATS), 'ZZ', '__proto__', 'constructor', 'toString']);
      const a: Address = {
        country,
        lines: r.array(0, 4, () => (r.bool(0.8) ? r.pick(LINE) : r.text(0, 10))),
        ...(r.bool(0.8) ? { city: r.pick(['Dayton', ' paris ', '{region}', '$&', '', 'São Paulo']) } : {}),
        ...(r.bool(0.6) ? { region: r.pick(['OH', 'nsw', '{postcode}', '']) } : {}),
        ...(r.bool(0.8) ? { postcode: r.pick(['45402', 'sw1a 1aa', '100-0001', '$`', '{city}', '']) } : {}),
      };
      return { a, ...(r.bool(0.4) ? { from: r.pick(['US', 'GB', country]) } : {}) };
    },
    shrink: () => [],
    check: ({ a, from }) => {
      const out = formatAddress(a, from);
      for (const l of out) assert.ok(l.length > 0 && l === l.trim(), `line ${JSON.stringify(l)}`);
      for (const l of a.lines.map((x) => x.trim()).filter(Boolean)) assert.ok(out.includes(l), `street line ${JSON.stringify(l)} lost`);
      const layout = (Object.hasOwn(FORMATS, a.country) ? FORMATS[a.country]!.layout : ['{city} {region} {postcode}']).join(' ');
      for (const k of ['city', 'region', 'postcode'] as const) {
        if (!layout.includes(`{${k}}`)) continue; // this country does not write it
        const v = (a[k] ?? '').trim();
        if (v && !/^[\s,-]+$/.test(v)) assert.ok(out.some((l) => l.toUpperCase().includes(v.toUpperCase().replace(/\s+/g, ' ').replace(/^[\s,-]+|[\s,-]+$/g, ''))), `${k} ${JSON.stringify(v)} lost`);
      }
      if (from && from !== a.country) assert.equal(out.at(-1), (Object.hasOwn(FORMATS, a.country) ? FORMATS[a.country]!.name : a.country).toUpperCase());
      const problems = checkAddress(a);
      assert.ok(Array.isArray(problems) && problems.every((p) => typeof p === 'string'));
    },
  });
});
