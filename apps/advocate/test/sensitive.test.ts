// Verifies docs/flows/sensitive-data.md
import { describe, expect, it } from 'vitest';
import { unclassified } from '@zthr/store';
import { COLLECTIONS } from '../src/domain/schema.js';
import { runTrace } from './harness/trace.js';

describe('sensitive data goes only where its class may go', async () => {
  const r = await runTrace();
  it('every field the app keeps is classified', () => expect(unclassified(COLLECTIONS)).toEqual([]));
  it('no planted marker turns up anywhere its class may not go', () => expect(r.leaks).toEqual([]));
  it('every planted personal and sensitive field was exercised by the run', () => expect(r.unexercised).toEqual([]));
  it('sealed facts and secrets appear nowhere in plain text', () => expect(r.sealedNowhere.sort()).toEqual(['api token (issued)', 'sealed: doc contents', 'sealed: justice_involvement']));
  it('the class-site token reaches only the class site, and the webhook secret only the store', () => {
    expect(r.findings.filter((f) => f.field === 'sealed: class_site_token').map((f) => f.sink)).toEqual(['network: campus services']);
    expect(r.findings.filter((f) => f.field === 'webhooks.secret').map((f) => f.sink)).toEqual(['store']);
  });
  it('the mentor platform receives the first name and approved note, and nothing sensitive', () => {
    const toCampus = r.findings.filter((f) => f.sink === 'network: campus services').map((f) => f.field);
    expect(toCampus).toEqual(expect.arrayContaining(['students.chosenName', 'drafts.body (mentor note)']));
    expect(r.findings.filter((f) => f.sink === 'network: campus services' && f.cls === 'sensitive')).toEqual([]);
  });
  it('the evidence log, the consent ledger, the admin, outcomes and logs hold no marker at all', () => {
    for (const sink of ['evidence', 'consent ledger', 'app admin', 'outcomes', 'server logs']) expect(r.findings.filter((f) => f.sink === sink).map((f) => f.field)).toEqual([]);
  });
});
