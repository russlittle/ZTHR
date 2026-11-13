import { z } from 'zod';
import type { Resource } from '../catalog/types.js';
import { isFresh } from '../catalog/types.js';
import { BARRIER, BARRIERS, DOMAIN_LABEL, PROVIDER_KINDS, PROVIDER_LABEL, SITUATION_LABEL, type ProviderKind } from './taxonomy.js';
import { recordLine, type Record_ } from './feedback.js';

/**
 * The public feed (docs/api/guide.md). The guide as data any app, college, library, congregation or agency can take
 * instead of doing the legwork: services, never students. Shaped after the Open Referral Human Services Data
 * Specification (service, organization, location, phone, eligibility, taxonomy), with each entry's source of record,
 * the day it was verified and whether it is current. Free to use with attribution.
 */
export const FEED_VERSION = '1.0';
export const LICENSE = {
  name: 'Creative Commons Attribution 4.0',
  url: 'https://creativecommons.org/licenses/by/4.0/',
  attribution: 'Community resource guide, Student Advocate (zthr.ai). Facts from each entry\'s cited source of record.',
};

export const FeedService = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  organization: z.object({ name: z.string(), kind: z.enum(PROVIDER_KINDS), kind_label: z.string(), level: z.string(), faith_note: z.string().optional() }),
  taxonomy: z.array(z.object({ barrier: z.string(), label: z.string(), domain: z.string(), domain_label: z.string() })).min(1),
  situations: z.array(z.object({ id: z.string(), label: z.string() })),
  serves: z.object({ counties: z.array(z.string()), colleges: z.array(z.string()), national: z.boolean() }),
  location: z.object({ address: z.string(), city: z.string(), postal_code: z.string().optional() }).optional(),
  phone: z.string().optional(),
  url: z.string().optional(),
  hours: z.string().optional(),
  cost: z.string().optional(),
  eligibility: z.string(),
  how_to_use: z.object({ steps: z.array(z.string()).min(1), documents: z.array(z.string()), what_to_expect: z.string().optional() }),
  availability: z.array(z.object({ fact: z.string(), value: z.string(), source: z.string(), checked_on: z.string() })),
  record: z.string().optional(),
  source: z.object({ url: z.string().url(), license: z.string() }),
  verification: z.object({ verified_on: z.string(), freshness_days: z.number(), current: z.boolean() }),
});
export type FeedService = z.infer<typeof FeedService>;

export const Feed = z.object({
  feed: z.literal('community-resource-guide'),
  version: z.string(),
  region: z.string(),
  generated_on: z.string(),
  license: z.object({ name: z.string(), url: z.string(), attribution: z.string() }),
  count: z.number(),
  services: z.array(FeedService),
});

export function toFeedService(r: Resource, today: string, record?: Record_): FeedService {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    organization: { name: r.organization, kind: r.provider.kind, kind_label: PROVIDER_LABEL[r.provider.kind], level: r.provider.level, ...(r.provider.faithNote ? { faith_note: r.provider.faithNote } : {}) },
    taxonomy: r.categories.map((c) => ({ barrier: c, label: BARRIER[c]?.label ?? c, domain: BARRIER[c]?.domain ?? 'feasible', domain_label: DOMAIN_LABEL[BARRIER[c]?.domain ?? 'feasible'] })),
    situations: (r.situations ?? []).map((s) => ({ id: s, label: SITUATION_LABEL[s] })),
    serves: { counties: r.serves.counties ?? [], colleges: r.serves.colleges ?? [], national: !!r.serves.national },
    ...(r.location ? { location: { address: r.location.address, city: r.location.city, ...(r.location.zip ? { postal_code: r.location.zip } : {}) } } : {}),
    ...(r.phone ? { phone: r.phone } : {}),
    ...(r.url ? { url: r.url } : {}),
    ...(r.hours ? { hours: r.hours } : {}),
    ...(r.cost ? { cost: r.cost } : {}),
    eligibility: r.eligibility.text,
    how_to_use: { steps: r.howToApply, documents: r.documents, ...(r.whatToExpect ? { what_to_expect: r.whatToExpect } : {}) },
    availability: (r.availability ?? []).map((f) => ({ fact: f.fact, value: f.value, source: f.source, checked_on: f.checkedOn })),
    ...(record && recordLine(record) ? { record: recordLine(record) } : {}),
    source: { url: r.source.url, license: r.source.license },
    verification: { verified_on: r.verifiedOn, freshness_days: r.freshnessDays, current: isFresh(r, today) },
  };
}

export function feed(catalog: Resource[], today: string, record?: (id: string) => Record_): z.infer<typeof Feed> {
  const services = catalog.map((r) => toFeedService(r, today, record?.(r.id)));
  return { feed: 'community-resource-guide', version: FEED_VERSION, region: 'Montgomery and Greene counties, Ohio', generated_on: today, license: LICENSE, count: services.length, services };
}

/** Coverage: for each barrier and county, how many current services and from which kinds of provider. Gaps are published. */
export interface CoverageCell {
  barrier: string;
  county: string;
  services: number;
  kinds: ProviderKind[];
}

export function coverage(catalog: Resource[], today: string, counties = ['Montgomery', 'Greene']): { cells: CoverageCell[]; gaps: { barrier: string; county: string }[] } {
  const cells: CoverageCell[] = [];
  for (const b of BARRIERS) {
    for (const county of counties) {
      const hits = catalog.filter((r) => isFresh(r, today) && r.categories.includes(b.id) && (r.serves.national || r.serves.counties?.includes(county) || (r.serves.colleges?.length ?? 0) > 0));
      cells.push({ barrier: b.id, county, services: hits.length, kinds: [...new Set(hits.map((r) => r.provider.kind))].sort() as ProviderKind[] });
    }
  }
  return { cells, gaps: cells.filter((c) => c.services === 0).map((c) => ({ barrier: c.barrier, county: c.county })) };
}
