// Verifies docs/flows/resource-guide.md
import { describe, expect, it } from 'vitest';
import { makeAdvocate, maria } from './helpers.js';
import { find } from '../src/guide/barriers.js';

/**
 * What students actually type, and where it must go. Each line is a phrasing a student might send, with the route
 * it must take: the tonight route (shelters by phone, and a barrier that stays open), a crisis line, or help for one
 * barrier in the taxonomy. The corpus also holds phrasings that must NOT take a route, because a false tonight
 * alarm or the wrong kind of help wastes a student's trust as surely as a miss.
 */
type Route = 'tonight' | 'crisis' | { need: string; first?: RegExp } | 'not-tonight';

const CORPUS: [string, Route][] = [
  // tonight: no safe place to stay
  ['I have nowhere to sleep tonight', 'tonight'],
  ['nowhere to stay tonight', 'tonight'],
  ['I am sleeping in my car', 'tonight'],
  ['my mom kicked me out', 'tonight'],
  ['my roommate threw me out', 'tonight'],
  ['I need a shelter', 'tonight'],
  ["I can't go home tonight", 'tonight'],
  ["I'm homeless right now", 'tonight'],
  ['I got locked out of my place', 'tonight'],
  ['no place to sleep', 'tonight'],
  // crisis lines come first, before any resource
  ['I want to die', 'crisis'],
  ['my boyfriend hit me', 'crisis'],
  ['he is threatening to kill me', 'crisis'],
  ['I am not safe at home', 'crisis'],
  // one barrier, with the help that fits what was said first
  ["I can't afford diapers", { need: 'goods', first: /Diaper/ }],
  ['I need a winter coat', { need: 'goods', first: /Life Enrichment|Clothes|Closet/ }],
  ['I need clothes for an interview', { need: 'goods' }],
  ['I lost my ID', { need: 'documents', first: /state ID/ }],
  ['I need my birth certificate', { need: 'documents' }],
  ['I feel really alone here', { need: 'belonging', first: /clubs/ }],
  ['how do I make friends on campus', { need: 'belonging' }],
  ['I need a job', { need: 'career', first: /OhioMeansJobs/ }],
  ['my hours got cut', { need: 'career' }],
  ['is there a free gym', { need: 'wellbeing' }],
  ['I want to start working out', { need: 'wellbeing' }],
  ["I'm a veteran", { need: 'belonging', first: /Military|Veteran/i }],
  ['I need a lawyer', { need: 'legal', first: /Legal Aid/ }],
  ["I can't find child care", { need: 'childcare' }],
  ['I need a tutor', { need: 'academic' }],
  ['I need accommodations for my disability', { need: 'academic' }],
  ['I want to volunteer', { need: 'opportunity' }],
  ['I am being stalked', { need: 'safety' }],
  ['I need a restraining order', { need: 'safety' }],
  ['I have panic attacks', { need: 'mental-health' }],
  ['my internet got cut', { need: 'phone-internet' }],
  // these are not about tonight, and must not raise the tonight route
  ['I got kicked out of my study group', 'not-tonight'],
  ['what time does the shelter house open on campus', 'not-tonight'],
  ['I slept in my car seat on the bus lol', 'not-tonight'],
  ['I am going home tonight', 'not-tonight'],
];

describe('the words students use reach the right help', () => {
  for (const [text, route] of CORPUS) {
    it(`"${text}"`, () => {
      const a = makeAdvocate();
      const s = maria(a);
      const [r] = a.converse(s.id, text);
      expect(r, 'a reply').toBeTruthy();
      const tonightOpen = find(a.barriers(s.id), 'emergency')?.urgency === 'tonight';
      if (route === 'tonight') {
        expect(r!.urgency).toBe('safety');
        expect(r!.text).toMatch(/safe place tonight/i);
        expect(r!.text).toMatch(/\d{3}-\d{3}-\d{4}/);
        expect(tonightOpen).toBe(true);
      } else if (route === 'crisis') {
        expect(r!.urgency).toBe('safety');
        expect(r!.text).toMatch(/988|911|799-7233/);
      } else if (route === 'not-tonight') {
        expect(r!.text).not.toMatch(/safe place tonight/i);
        expect(tonightOpen).toBe(false);
      } else {
        expect(r!.text, r!.text).not.toMatch(/I'm not sure I got that/);
        expect(r!.text).not.toMatch(/safe place tonight/i);
        const asked = a.evidence.events('find_help').at(-1)?.data.need;
        expect(asked, `routed to ${String(asked)}: ${r!.text.slice(0, 80)}`).toBe(route.need);
        if (route.first) expect(r!.text.split('\n')[1] ?? r!.text, r!.text).toMatch(route.first);
      }
    });
  }

  it('a crisis message to the abuse route names the domestic violence hotline', () => {
    const a = makeAdvocate();
    const s = maria(a);
    expect(a.converse(s.id, 'my boyfriend hit me')[0]!.text).toMatch(/1-800-799-7233/);
  });
});

describe('a first text about tonight gets shelters before any sign-up question', () => {
  for (const text of ['I have nowhere to sleep tonight', 'my dad kicked me out', 'sleeping in my car tonight']) {
    it(`"${text}" from a number the Advocate has never seen`, () => {
      const a = makeAdvocate();
      const [first, next] = a.textIn('+19375550777', text);
      expect(first).toMatch(/safe place tonight/i);
      expect(first).toMatch(/2-1-1/);
      expect(first).toMatch(/911/);
      expect((first!.match(/\d{3}-\d{3}-\d{4}/g) ?? []).length).toBeGreaterThanOrEqual(3);
      expect(first).not.toMatch(/ZIP|which college/i);
      expect(next).toMatch(/ZIP/);
      expect(a.evidence.events('safety_route').at(-1)?.data.categories).toEqual(['no-safe-place-tonight']);
    });
  }
  it('an ordinary first text still starts sign-up', () => {
    const a = makeAdvocate();
    expect(a.textIn('+19375550778', 'hi').join(' ')).toMatch(/ZIP/);
    expect(a.textIn('+19375550779', 'hi').join(' ')).not.toMatch(/safe place tonight/i);
  });
  it('a crisis first text still goes to the crisis lines first', () => {
    const a = makeAdvocate();
    expect(a.textIn('+19375550780', 'I want to die and I have nowhere to sleep')[0]).toMatch(/988/);
  });
});
