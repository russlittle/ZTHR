/**
 * Trash and restore, and the retention sweep. Deleting a record moves it and everything that depends on it to the
 * trash together, so a restore brings all of it back and nothing is left pointing at nothing. A sweep plans, from
 * each record kind's retention policy, what to purge from the trash and what to archive or purge from the live
 * records, and says why for each. The plan is data: the job that carries it out records what it did.
 */

export interface Item {
  readonly kind: string;
  readonly id: string;
  /** Records this one depends on, by kind and id: it goes to the trash with any of them. */
  readonly parents?: readonly { readonly kind: string; readonly id: string }[];
  readonly createdAt: number;
  readonly closedAt?: number | null;
  readonly trashedAt?: number | null;
  /** A legal hold keeps a record whatever its policy says. */
  readonly hold?: boolean;
}

export interface Policy {
  /** Days a closed record is kept live before the action applies. Null keeps it for good. */
  readonly keepDays: number | null;
  readonly then: 'archive' | 'purge';
  /** Days a trashed record can be restored before it is purged. */
  readonly trashDays: number;
}

const DAY = 86_400_000;
const key = (x: { kind: string; id: string }) => `${x.kind}:${x.id}`;

/** Everything that goes with a record into the trash: the record and, transitively, every record depending on it. */
export function withDependents(items: readonly Item[], root: { kind: string; id: string }): Item[] {
  const out = new Map<string, Item>();
  const stack = [key(root)];
  while (stack.length) {
    const k = stack.pop()!;
    if (out.has(k)) continue;
    const it = items.find((x) => key(x) === k);
    if (!it) continue;
    out.set(k, it);
    for (const c of items) if (c.parents?.some((p) => key(p) === k)) stack.push(key(c));
  }
  return [...out.values()];
}

export const trash = (items: readonly Item[], root: { kind: string; id: string }, now: number): Item[] => {
  const set = new Set(withDependents(items, root).map(key));
  return items.map((x) => (set.has(key(x)) && x.trashedAt == null ? { ...x, trashedAt: now } : x));
};

/** Restore a record and everything that went into the trash with it, at the same moment. */
export const restore = (items: readonly Item[], root: { kind: string; id: string }): Item[] => {
  const r = items.find((x) => key(x) === key(root));
  if (r?.trashedAt == null) return [...items];
  const set = new Set(withDependents(items, root).filter((x) => x.trashedAt === r.trashedAt).map(key));
  return items.map((x) => (set.has(key(x)) ? { ...x, trashedAt: null } : x));
};

export interface Step {
  readonly kind: string;
  readonly id: string;
  readonly action: 'purge' | 'archive';
  readonly why: string;
}

export function sweep(items: readonly Item[], policies: Readonly<Record<string, Policy>>, now: number): { steps: Step[]; held: number; noPolicy: string[] } {
  const steps: Step[] = [];
  const noPolicy = new Set<string>();
  let held = 0;
  for (const x of items) {
    const p = policies[x.kind];
    if (!p) {
      noPolicy.add(x.kind);
      continue;
    }
    if (x.hold) {
      held++;
      continue;
    }
    if (x.trashedAt != null && now - x.trashedAt >= p.trashDays * DAY) steps.push({ kind: x.kind, id: x.id, action: 'purge', why: `in the trash ${p.trashDays} days` });
    else if (x.trashedAt == null && x.closedAt != null && p.keepDays !== null && now - x.closedAt >= p.keepDays * DAY) steps.push({ kind: x.kind, id: x.id, action: p.then, why: `closed more than ${p.keepDays} days` });
  }
  return { steps, held, noPolicy: [...noPolicy].sort() };
}
