import { createHash } from 'node:crypto';

/**
 * Exhaustive exploration of an interactive system (model-based testing).
 *
 * A world is built fresh from a seed and driven by actions. Each node in the search is the path of actions that
 * reached it; nodes are deduplicated by a signature of the world's state, so the search runs to a fixpoint: it
 * stops only when no action from any reached state leads anywhere new. At every step the caller's invariants are
 * checked, so a violation reports the exact path that produced it and can be replayed.
 *
 * Reusable by any app: supply seeds, how to list and perform actions, a state signature and invariants.
 */
export interface Step<O> {
  action: string;
  outcome: O;
}

export interface ExploreSpec<W, O> {
  /** Named starting worlds, each built fresh on every replay. */
  seeds: { name: string; make: () => W }[];
  /** Actions available from the world after the given outcome (undefined outcome: at the start). */
  actions: (world: W, last: O | undefined) => string[];
  /** Perform one action. Throwing is recorded as a violation, not a crash of the search. */
  perform: (world: W, action: string) => O;
  /** A stable fingerprint of the world's state plus whatever the user can see next. */
  signature: (world: W, last: O | undefined) => string;
  /** Invariants checked after every action. Return a list of problems; empty means fine. */
  check?: (world: W, step: Step<O>, path: string[]) => string[];
  /**
   * Freeze a world to plain data and thaw it back. When given, the walk keeps a frozen copy of each state to
   * expand instead of replaying its path from the start; frozen copies are small, so wide walks fit in memory.
   */
  freeze?: (world: W) => unknown;
  thaw?: (frozen: unknown) => W;
  /** Safety valve for runaway state spaces; reaching it is reported, never hidden. */
  maxNodes?: number;
}

export interface Violation {
  seed: string;
  path: string[];
  problem: string;
}

export interface ExploreReport {
  seeds: { name: string; states: number; transitions: number; maxDepth: number; exhausted: boolean }[];
  states: number;
  transitions: number;
  actionsSeen: string[];
  verbsSeen: Record<string, number>;
  violations: Violation[];
  exhausted: boolean;
}

export const hash = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 16);

/** The verb of an action: the part before the first colon. */
export const verbOf = (action: string): string => action.split(':')[0]!;

export function explore<W, O>(spec: ExploreSpec<W, O>): ExploreReport {
  const max = spec.maxNodes ?? 50_000;
  const report: ExploreReport = { seeds: [], states: 0, transitions: 0, actionsSeen: [], verbsSeen: {}, violations: [], exhausted: true };
  const actionsSeen = new Set<string>();
  for (const seed of spec.seeds) {
    const seen = new Set<string>();
    const queue: string[][] = [[]];
    const frozen = new Map<string[], { data: unknown; last: O | undefined }>();
    const keep = !!(spec.freeze && spec.thaw);
    let transitions = 0;
    let maxDepth = 0;
    let exhausted = true;
    const replay = (path: string[]): { world: W; last: O | undefined } => {
      const world = seed.make();
      let last: O | undefined;
      for (const a of path) last = spec.perform(world, a);
      return { world, last };
    };
    {
      const start = replay([]);
      seen.add(spec.signature(start.world, start.last));
      if (keep) frozen.set(queue[0]!, { data: spec.freeze!(start.world), last: start.last });
    }
    while (queue.length) {
      if (seen.size >= max) {
        exhausted = false;
        break;
      }
      const path = queue.shift()!;
      const stored = keep ? frozen.get(path)! : undefined;
      frozen.delete(path);
      const base = stored ? { world: spec.thaw!(stored.data), last: stored.last } : replay(path);
      const options = [...new Set(spec.actions(base.world, base.last))];
      for (const action of options) {
        actionsSeen.add(action);
        report.verbsSeen[verbOf(action)] = (report.verbsSeen[verbOf(action)] ?? 0) + 1;
        const world = stored ? spec.thaw!(stored.data) : replay(path).world;
        const next = [...path, action];
        let outcome: O;
        transitions++;
        try {
          outcome = spec.perform(world, action);
        } catch (e) {
          report.violations.push({ seed: seed.name, path: next, problem: `crashed: ${(e as Error).message}` });
          continue;
        }
        for (const problem of spec.check?.(world, { action, outcome }, next) ?? []) report.violations.push({ seed: seed.name, path: next, problem });
        const sig = spec.signature(world, outcome);
        if (seen.has(sig)) continue;
        seen.add(sig);
        maxDepth = Math.max(maxDepth, next.length);
        queue.push(next);
        if (keep) frozen.set(next, { data: spec.freeze!(world), last: outcome });
      }
    }
    report.seeds.push({ name: seed.name, states: seen.size, transitions, maxDepth, exhausted });
    report.states += seen.size;
    report.transitions += transitions;
    report.exhausted &&= exhausted;
  }
  report.actionsSeen = [...actionsSeen].sort();
  return report;
}
