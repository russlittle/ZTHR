// Verifies docs/security.md
import { describe, expect, it } from 'vitest';
import { PROTECTED, touchesProtected, unsigned, type CommitInfo } from '../person-signed.js';

const c = (over: Partial<CommitInfo>): CommitInfo => ({ sha: 'abcdef1234567', login: 'russlittle', verified: true, reason: 'valid', files: ['control/lock.json'], ...over });
const people = { russ: 'russlittle' };

describe('what only a person changes is changed only by a person', () => {
  it('protects the locked cards, the lock, people, resets, floors, the required checks and this rule itself', () => {
    expect(touchesProtected(['control/journeys/p6-x.yaml', 'control/lock.json', 'control/people.json', 'control/ratchet-resets.jsonl', 'control/mutation-floors.json', 'control/required-checks.yaml', 'tools/person-signed.ts'])).toHaveLength(7);
    expect(touchesProtected(['control/journeys.md', 'control/lock.json.bak', 'apps/advocate/src/x.ts', 'tools/person-signed.test.ts'])).toEqual([]);
    expect(PROTECTED).toContain('tools/person-signed.ts');
  });
  it('a verified commit by a listed person passes; a commit touching nothing protected passes from anyone', () => {
    expect(unsigned([c({}), c({ login: 'claude-agent', verified: false, files: ['apps/advocate/src/x.ts'] })], people)).toEqual([]);
    expect(unsigned([c({ login: 'RussLittle' })], people)).toEqual([]);
  });
  it('an unverified commit, an agent, or no GitHub account fails by name', () => {
    expect(unsigned([c({ verified: false, reason: 'unsigned' })], people)).toEqual(['abcdef1 changes control/lock.json: not verified by GitHub (unsigned)']);
    expect(unsigned([c({ login: 'claude-agent' })], people)).toEqual(['abcdef1 changes control/lock.json: authored by claude-agent, not a listed person']);
    expect(unsigned([c({ login: undefined })], people)).toEqual(['abcdef1 changes control/lock.json: authored by no GitHub account, not a listed person']);
    expect(unsigned([c({ login: 'claude-agent', files: ['control/journeys/a.yaml', 'control/journeys/b.yaml', 'control/journeys/c.yaml', 'control/journeys/d.yaml'] })], people)[0]).toBe('abcdef1 changes control/journeys/a.yaml, control/journeys/b.yaml, control/journeys/c.yaml: authored by claude-agent, not a listed person');
  });
  it('with no listed person, no protected change passes', () => {
    expect(unsigned([c({})], {})).toHaveLength(1);
  });
});
