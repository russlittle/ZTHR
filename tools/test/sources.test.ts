// Verifies docs/data-sources.md
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { unclassified } from '@zthr/store';
import * as K from '../../apps/campus-services/src/contracts.js';
import { sources, zodFields } from '../sources.js';

describe('data sources', () => {
  it('reads fields, types and optionality from a contract schema', () => {
    const f = zodFields(z.object({ a: z.string(), b: z.number().optional(), c: z.array(z.enum(['x'])), d: z.string().nullable(), e: z.record(z.string()) }), 'public', { a: 'personal' });
    expect(f.map((x) => `${x.name}:${x.type}:${x.optional}:${x.cls}`)).toEqual(['a:string:false:personal', 'b:number:true:public', 'c:enum[]:false:public', 'd:string:true:public', 'e:record:false:public']);
  });
  it('every campus contract entity is drawn with all of its fields', () => {
    const drawn = new Map(sources().flatMap((s) => s.entities.map((e) => [e.name, e.fields.map((f) => f.name)] as const)));
    for (const name of ['DiningLocation', 'MenuItem', 'Stop', 'Itinerary', 'Leg', 'Arrival', 'Alert', 'Space', 'Reservation', 'Event', 'Posting', 'Mentor', 'MentorRequest', 'LmsCourse', 'LmsAssignment', 'LmsAnnouncement'] as const) {
      expect(drawn.get(name), name).toEqual(Object.keys((K[name] as z.AnyZodObject).shape));
    }
  });
  it('every source field is classified, and what a student sends is personal', () => {
    const all = sources().flatMap((s) => s.entities);
    expect(unclassified(all)).toEqual([]);
    const req = all.find((e) => e.name === 'MentorRequest')!;
    expect(req.fields.filter((f) => f.cls === 'personal').map((f) => f.name)).toEqual(['firstName', 'note', 'meeting']);
  });
});
