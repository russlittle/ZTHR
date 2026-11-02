import { describe, expect, it } from 'vitest';
import { OpenRouterClient, TwinModelClient } from '@zthr/models';
import { parseReview, promptFor, reviewPanel, type Seat } from '@zthr/review';

const twin = (text: string) => new TwinModelClient(() => text);
const ok = '{"verdict":"pass","findings":[]}';

describe('review panel', () => {
  it('requires three families before commit', async () => {
    const seats: Seat[] = [
      { role: 'context-aided', family: 'a', model: 'm', client: twin(ok) },
      { role: 'unaided', family: 'a', model: 'm', client: twin(ok) },
      { role: 'independent', family: 'b', model: 'm', client: twin(ok) },
    ];
    expect((await reviewPanel(seats, { diff: 'd', intent: 'i' })).verdict.status).toBe('fail');
  });
  it('passes with three families that find nothing', async () => {
    const seats: Seat[] = [
      { role: 'context-aided', family: 'a', model: 'm', client: twin(ok) },
      { role: 'unaided', family: 'b', model: 'm', client: twin(ok) },
      { role: 'independent', family: 'c', model: 'm', client: twin(ok) },
    ];
    expect((await reviewPanel(seats, { diff: 'd', intent: 'i' })).verdict.status).toBe('pass');
  });
  it('a blocking finding from any seat fails the change', async () => {
    const seats: Seat[] = [
      { role: 'context-aided', family: 'a', model: 'm', client: twin(ok) },
      { role: 'unaided', family: 'b', model: 'm', client: twin('{"verdict":"pass","findings":[{"severity":"blocker","summary":"sends without approval"}]}') },
      { role: 'independent', family: 'c', model: 'm', client: twin(ok) },
    ];
    expect((await reviewPanel(seats, { diff: 'd', intent: 'i' })).verdict.status).toBe('fail');
  });
  it('an unavailable provider is unknown, never pass', async () => {
    const seats: Seat[] = [
      { role: 'context-aided', family: 'a', model: 'm', client: twin(ok) },
      { role: 'unaided', family: 'b', model: 'm', client: new OpenRouterClient('') },
      { role: 'independent', family: 'c', model: 'm', client: twin(ok) },
    ];
    expect((await reviewPanel(seats, { diff: 'd', intent: 'i' })).verdict.status).toBe('unknown');
  });
  it('the unaided seat sees only the diff', () => {
    const p = promptFor('unaided', { diff: 'THE DIFF', intent: 'SECRET INTENT', context: 'SECRET CONTEXT' });
    expect(p).toContain('THE DIFF');
    expect(p).not.toContain('SECRET');
  });
  it('unparseable output is not a pass', () => expect(parseReview('looks good to me!')).toBeUndefined());
});
