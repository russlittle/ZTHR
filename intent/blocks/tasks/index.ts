/**
 * Tasks as a work list people share: a task has a title, notes, a status, subtasks to a set depth, assignees,
 * labels, a priority, start and due dates, a checklist, reminders before the due date, and an optional recurrence.
 * Status changes follow a declared workflow (todo, doing, done, cancelled; reopen from either end) run by the
 * workflow block, so an action that is not allowed says why; completing a task with open subtasks is refused unless
 * the caller asks to complete them with it. Completing a recurring task creates the next one: the next due date
 * comes from the recurrence rule (RFC 5545 RRULE as the time block reads it) in the task's own time zone, so a
 * 9:00 task stays at 9:00 across daylight-saving changes; "after completion" tasks count from when it was done; an
 * ended rule (COUNT or UNTIL reached) creates nothing. Progress rolls up through subtasks and the checklist;
 * siblings keep an order by fractional rank, so moving one writes one task; moves that would make a task its own
 * ancestor are refused. Reminders say what is due and are marked once sent. Clock and ids are arguments.
 *
 * Out of scope: sharing and permission checks (the caller decides who may act; assignment here only records and
 * limits), notification delivery (see notify), and calendars (see icalendar and caldav).
 */
import { check, Workflow } from '../workflow/index.ts';
import type { Definition, Instance } from '../workflow/index.ts';
import { occurrences, parseRule, wallOf } from '../time/index.ts';

export class TaskError extends Error {}

export type Status = 'todo' | 'doing' | 'done' | 'cancelled';
export type Priority = 'none' | 'low' | 'medium' | 'high' | 'urgent';
export const PRIORITIES: readonly Priority[] = ['none', 'low', 'medium', 'high', 'urgent'];

export interface Recurrence {
  /** RRULE text, e.g. "FREQ=WEEKLY;BYDAY=MO,TH". */
  readonly rule: string;
  readonly tz: string;
  /** "fixed": from the schedule. "afterCompletion": the next one counts from when this was done. */
  readonly mode: 'fixed' | 'afterCompletion';
}

export interface ChecklistItem {
  readonly id: string;
  text: string;
  done: boolean;
}

export interface Task {
  readonly id: string;
  title: string;
  notes: string;
  status: Status;
  parent: string | undefined;
  assignees: string[];
  labels: string[];
  priority: Priority;
  /** Epoch ms. */
  start: number | undefined;
  due: number | undefined;
  recurrence: Recurrence | undefined;
  /** Milliseconds before the due date at which to remind, each once per due date. */
  reminders: number[];
  checklist: ChecklistItem[];
  rank: string;
  readonly createdAt: number;
  readonly createdBy: string;
  updatedAt: number;
  completedAt: number | undefined;
  /** The task this one was created from when a recurring task was completed. */
  readonly previous: string | undefined;
  /** Count of earlier tasks in the same recurring series. */
  readonly seriesIndex: number;
  /** The due date of the first task in the series, so COUNT is counted from the start of the series. */
  readonly seriesStart: number | undefined;
}

export interface NewTask {
  readonly title: string;
  readonly notes?: string;
  readonly parent?: string;
  readonly assignees?: readonly string[];
  readonly labels?: readonly string[];
  readonly priority?: Priority;
  readonly start?: number;
  readonly due?: number;
  readonly recurrence?: Recurrence;
  readonly reminders?: readonly number[];
  readonly checklist?: readonly string[];
}

export interface TaskOptions {
  readonly now?: () => number;
  readonly newId?: () => string;
  readonly maxDepth?: number;
  readonly maxChildren?: number;
  readonly maxAssignees?: number;
  readonly maxLabels?: number;
  readonly maxChecklist?: number;
  readonly maxTasks?: number;
}

export interface LogEntry {
  readonly at: number;
  readonly by: string;
  readonly task: string;
  readonly what: string;
}

export interface Reminder {
  readonly task: string;
  readonly title: string;
  readonly due: number;
  readonly at: number;
  readonly assignees: readonly string[];
}

export interface Filter {
  readonly status?: readonly Status[];
  readonly assignee?: string;
  readonly label?: string;
  readonly priority?: Priority;
  /** Only tasks due before this instant. */
  readonly dueBefore?: number;
  readonly overdueAt?: number;
  readonly parent?: string | null;
  readonly text?: string;
}

const DEFINITION: Definition = {
  name: 'task',
  start: 'todo',
  final: ['done', 'cancelled'],
  transitions: [
    { from: 'todo', to: 'doing', action: 'start', roles: ['member'] },
    { from: 'doing', to: 'todo', action: 'pause', roles: ['member'] },
    { from: 'todo', to: 'done', action: 'complete', roles: ['member'], guard: (r) => (r['openChildren'] ? `${r['openChildren']} subtask(s) are still open` : undefined) },
    { from: 'doing', to: 'done', action: 'complete', roles: ['member'], guard: (r) => (r['openChildren'] ? `${r['openChildren']} subtask(s) are still open` : undefined) },
    { from: 'todo', to: 'cancelled', action: 'cancel', roles: ['member'] },
    { from: 'doing', to: 'cancelled', action: 'cancel', roles: ['member'] },
    { from: 'done', to: 'todo', action: 'reopen', roles: ['member'] },
    { from: 'cancelled', to: 'todo', action: 'reopen', roles: ['member'] },
  ],
};

const ROLES = ['member'] as const;
const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz';

/** A rank string strictly between `a` and `b` (either may be absent for the ends). */
export function rankBetween(a: string | undefined, b: string | undefined): string {
  const lo = a ?? '';
  const hi = b ?? '';
  if (hi !== '' && lo >= hi) throw new TaskError('rankBetween needs a < b');
  let out = '';
  for (let i = 0; ; i++) {
    const x = i < lo.length ? DIGITS.indexOf(lo[i]!) : 0;
    const y = b !== undefined && i < hi.length && out === hi.slice(0, i) ? DIGITS.indexOf(hi[i]!) : DIGITS.length;
    if (y - x > 1) return out + DIGITS[Math.floor((x + y) / 2)]!;
    out += DIGITS[x]!;
  }
}

const normLabel = (l: string) => l.trim().toLowerCase().replace(/\s+/g, '-');

export class Tasks {
  private readonly tasks = new Map<string, Task>();
  private readonly flows = new Map<string, Instance>();
  private readonly sent = new Set<string>();
  readonly log: LogEntry[] = [];
  private readonly o: Required<Pick<TaskOptions, 'maxDepth' | 'maxChildren' | 'maxAssignees' | 'maxLabels' | 'maxChecklist' | 'maxTasks'>>;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly wf: Workflow;
  private seq = 0;

  constructor(o: TaskOptions = {}) {
    this.now = o.now ?? Date.now;
    this.newId = o.newId ?? (() => `t${++this.seq}`);
    this.o = { maxDepth: o.maxDepth ?? 8, maxChildren: o.maxChildren ?? 500, maxAssignees: o.maxAssignees ?? 20, maxLabels: o.maxLabels ?? 30, maxChecklist: o.maxChecklist ?? 200, maxTasks: o.maxTasks ?? 1_000_000 };
    const problems = check(DEFINITION);
    if (problems.length) throw new Error(problems.join('; '));
    this.wf = new Workflow(DEFINITION, this.now);
  }

  private note(by: string, task: string, what: string) {
    this.log.push({ at: this.now(), by, task, what });
  }

  get(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  private must(id: string): Task {
    const t = this.tasks.get(id);
    if (!t) throw new TaskError(`no task ${id}`);
    return t;
  }

  private depthOf(id: string | undefined): number {
    let d = 0;
    for (let p = id; p; p = this.tasks.get(p)?.parent) {
      d++;
      if (d > 1000) throw new TaskError('the task tree is damaged');
    }
    return d;
  }

  private heightOf(id: string): number {
    let h = 0;
    for (const c of this.children(id)) h = Math.max(h, 1 + this.heightOf(c.id));
    return h;
  }

  private checkFields(t: { title?: string; assignees?: readonly string[]; labels?: readonly string[]; priority?: Priority; reminders?: readonly number[]; start?: number | undefined; due?: number | undefined; recurrence?: Recurrence | undefined }) {
    if (t.title !== undefined && (!t.title.trim() || t.title.length > 500)) throw new TaskError('a title is 1 to 500 characters');
    if (t.assignees && new Set(t.assignees).size > this.o.maxAssignees) throw new TaskError(`at most ${this.o.maxAssignees} assignees`);
    if (t.labels && new Set(t.labels.map(normLabel)).size > this.o.maxLabels) throw new TaskError(`at most ${this.o.maxLabels} labels`);
    if (t.labels?.some((l) => !normLabel(l) || normLabel(l).length > 50)) throw new TaskError('a label is 1 to 50 characters');
    if (t.priority !== undefined && !PRIORITIES.includes(t.priority)) throw new TaskError(`priority must be one of ${PRIORITIES.join(', ')}`);
    if (t.reminders?.some((r) => !Number.isFinite(r) || r < 0 || r > 366 * 86_400_000)) throw new TaskError('a reminder is 0 to 366 days before the due date');
    if (t.start !== undefined && t.due !== undefined && t.start > t.due) throw new TaskError('the start is after the due date');
    if (t.recurrence) {
      if (t.due === undefined) throw new TaskError('a recurring task needs a due date');
      try {
        parseRule(t.recurrence.rule);
        wallOf(new Date(0), t.recurrence.tz);
      } catch (e) {
        throw new TaskError(`the recurrence is not valid: ${(e as Error).message}`);
      }
    }
  }

  create(input: NewTask, by: string): Task {
    if (this.tasks.size >= this.o.maxTasks) throw new TaskError('too many tasks');
    this.checkFields(input);
    if (input.parent !== undefined) {
      this.must(input.parent);
      if (this.depthOf(input.parent) + 1 > this.o.maxDepth) throw new TaskError(`subtasks go at most ${this.o.maxDepth} levels deep`);
      if (this.children(input.parent).length >= this.o.maxChildren) throw new TaskError(`a task has at most ${this.o.maxChildren} subtasks`);
    }
    if ((input.checklist?.length ?? 0) > this.o.maxChecklist) throw new TaskError(`at most ${this.o.maxChecklist} checklist items`);
    const sibs = this.children(input.parent);
    const t: Task = {
      id: this.newId(),
      title: input.title.trim(),
      notes: input.notes ?? '',
      status: 'todo',
      parent: input.parent,
      assignees: [...new Set(input.assignees ?? [])],
      labels: [...new Set((input.labels ?? []).map(normLabel))],
      priority: input.priority ?? 'none',
      start: input.start,
      due: input.due,
      recurrence: input.recurrence,
      reminders: [...new Set(input.reminders ?? [])].sort((a, b) => b - a),
      checklist: (input.checklist ?? []).map((text, i) => ({ id: `c${i + 1}`, text, done: false })),
      rank: rankBetween(sibs.length ? sibs[sibs.length - 1]!.rank : undefined, undefined),
      createdAt: this.now(),
      createdBy: by,
      updatedAt: this.now(),
      completedAt: undefined,
      previous: undefined,
      seriesIndex: 0,
      seriesStart: input.due,
    };
    this.tasks.set(t.id, t);
    this.flows.set(t.id, this.wf.start(t.id, by));
    this.note(by, t.id, 'created');
    return t;
  }

  update(id: string, patch: { title?: string; notes?: string; priority?: Priority; start?: number | undefined; due?: number | undefined; recurrence?: Recurrence | undefined; reminders?: readonly number[] }, by: string): Task {
    const t = this.must(id);
    const merged = { start: 'start' in patch ? patch.start : t.start, due: 'due' in patch ? patch.due : t.due, recurrence: 'recurrence' in patch ? patch.recurrence : t.recurrence };
    this.checkFields({ ...patch, ...merged });
    const changed: string[] = [];
    if (patch.title !== undefined) (t.title = patch.title.trim(), changed.push('title'));
    if (patch.notes !== undefined) (t.notes = patch.notes, changed.push('notes'));
    if (patch.priority !== undefined) (t.priority = patch.priority, changed.push('priority'));
    if ('start' in patch) (t.start = patch.start, changed.push('start'));
    if ('due' in patch) (t.due = patch.due, changed.push('due'));
    if ('recurrence' in patch) (t.recurrence = patch.recurrence, changed.push('recurrence'));
    if (patch.reminders) (t.reminders = [...new Set(patch.reminders)].sort((a, b) => b - a), changed.push('reminders'));
    t.updatedAt = this.now();
    if (changed.length) this.note(by, id, `changed ${changed.join(', ')}`);
    return t;
  }

  children(parent: string | undefined): Task[] {
    return [...this.tasks.values()].filter((t) => t.parent === parent).sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.id < b.id ? -1 : 1));
  }

  descendants(id: string): Task[] {
    return this.children(id).flatMap((c) => [c, ...this.descendants(c.id)]);
  }

  /** Moves a task under a new parent (or to the top), before a sibling or last. Refuses loops and too-deep trees. */
  move(id: string, parent: string | undefined, beforeId: string | undefined, by: string): Task {
    const t = this.must(id);
    if (parent !== undefined) {
      this.must(parent);
      for (let p: string | undefined = parent; p; p = this.tasks.get(p)?.parent) if (p === id) throw new TaskError('a task cannot be moved under itself');
      if (this.depthOf(parent) + 1 + this.heightOf(id) > this.o.maxDepth) throw new TaskError(`subtasks go at most ${this.o.maxDepth} levels deep`);
      if (parent !== t.parent && this.children(parent).length >= this.o.maxChildren) throw new TaskError(`a task has at most ${this.o.maxChildren} subtasks`);
    }
    const sibs = this.children(parent).filter((s) => s.id !== id);
    let prev: string | undefined;
    let next: string | undefined;
    if (beforeId !== undefined) {
      const i = sibs.findIndex((s) => s.id === beforeId);
      if (i < 0) throw new TaskError(`${beforeId} is not under that parent`);
      next = sibs[i]!.rank;
      prev = sibs[i - 1]?.rank;
    } else prev = sibs[sibs.length - 1]?.rank;
    t.parent = parent;
    t.rank = rankBetween(prev, next);
    t.updatedAt = this.now();
    this.note(by, id, `moved under ${parent ?? 'the top'}`);
    return t;
  }

  private act(t: Task, action: string, by: string, extra: Record<string, unknown> = {}) {
    const flow = this.flows.get(t.id)!;
    flow.state = t.status;
    Object.assign(flow.data, { openChildren: this.descendants(t.id).filter((d) => d.status === 'todo' || d.status === 'doing').length }, extra);
    this.wf.act(flow, action, by, ROLES);
    t.status = flow.state as Status;
    t.updatedAt = this.now();
  }

  /** What this person can do with the task now, and why not for the rest. */
  actions(id: string): { action: string; ok: boolean; why?: string }[] {
    const t = this.must(id);
    const flow = this.flows.get(id)!;
    flow.state = t.status;
    flow.data['openChildren'] = this.descendants(id).filter((d) => d.status === 'todo' || d.status === 'doing').length;
    return this.wf.actions(flow, ROLES);
  }

  start(id: string, by: string): Task {
    const t = this.must(id);
    this.act(t, 'start', by);
    this.note(by, id, 'started');
    return t;
  }

  pause(id: string, by: string): Task {
    const t = this.must(id);
    this.act(t, 'pause', by);
    this.note(by, id, 'paused');
    return t;
  }

  /**
   * Completes a task. Open subtasks refuse it unless `withSubtasks`, which completes them too. A recurring task
   * creates its next one (returned as `next`) unless the rule has ended.
   */
  complete(id: string, by: string, o: { withSubtasks?: boolean } = {}): { task: Task; next: Task | undefined } {
    const t = this.must(id);
    if (o.withSubtasks) {
      for (const d of this.descendants(id).reverse())
        if (d.status === 'todo' || d.status === 'doing') {
          this.act(d, 'complete', by);
          d.completedAt = this.now();
          this.note(by, d.id, 'completed with its parent');
        }
    }
    this.act(t, 'complete', by);
    t.completedAt = this.now();
    this.note(by, id, 'completed');
    let next: Task | undefined;
    if (t.recurrence && t.due !== undefined) {
      const due = this.nextDue(t);
      if (due !== undefined) {
        next = this.create({ title: t.title, notes: t.notes, ...(t.parent !== undefined ? { parent: t.parent } : {}), assignees: t.assignees, labels: t.labels, priority: t.priority, due, recurrence: t.recurrence, reminders: t.reminders, checklist: t.checklist.map((c) => c.text), ...(t.start !== undefined ? { start: due - (t.due - t.start) } : {}) }, by);
        (next as { previous: string | undefined }).previous = t.id;
        (next as { seriesIndex: number }).seriesIndex = t.seriesIndex + 1;
        (next as { seriesStart: number | undefined }).seriesStart = t.seriesStart;
        next.rank = t.rank;
        this.note(by, next.id, `created from ${t.id} by recurrence`);
      }
    }
    return { task: t, next };
  }

  /** The due date of the next task in a recurring series, or undefined when the rule has ended. */
  nextDue(t: Task): number | undefined {
    const r = t.recurrence;
    if (!r || t.due === undefined) return undefined;
    const rule = parseRule(r.rule);
    const completed = t.completedAt ?? this.now();
    if (r.mode === 'afterCompletion') {
      // each task counts from its own completion, so COUNT is the number of tasks in the series
      if (rule.count !== undefined && t.seriesIndex + 1 >= rule.count) return undefined;
      const { count: _drop, ...open } = rule;
      const list = occurrences(wallOf(new Date(completed), r.tz), r.tz, open, { limit: 1, after: new Date(completed + 1) });
      return list[0]?.getTime();
    }
    // "fixed" skips occurrences already in the past when completed late, so a long-overdue task does not spawn a backlog
    const after = new Date(Math.max(t.due, completed) + 1);
    const list = occurrences(wallOf(new Date(t.seriesStart ?? t.due), r.tz), r.tz, rule, { limit: 1, after });
    return list[0]?.getTime();
  }

  reopen(id: string, by: string): Task {
    const t = this.must(id);
    this.act(t, 'reopen', by);
    t.completedAt = undefined;
    this.note(by, id, 'reopened');
    return t;
  }

  cancel(id: string, by: string): Task {
    const t = this.must(id);
    this.act(t, 'cancel', by);
    this.note(by, id, 'cancelled');
    return t;
  }

  /** Deletes a task and everything under it. Returns how many tasks went. */
  delete(id: string, by: string): number {
    this.must(id);
    const all = [this.must(id), ...this.descendants(id)];
    for (const t of all) {
      this.tasks.delete(t.id);
      this.flows.delete(t.id);
    }
    this.note(by, id, `deleted with ${all.length - 1} subtask(s)`);
    return all.length;
  }

  assign(id: string, who: string, by: string): Task {
    const t = this.must(id);
    if (!who.trim()) throw new TaskError('who?');
    if (t.assignees.includes(who)) return t;
    if (t.assignees.length >= this.o.maxAssignees) throw new TaskError(`at most ${this.o.maxAssignees} assignees`);
    t.assignees.push(who);
    t.updatedAt = this.now();
    this.note(by, id, `assigned ${who}`);
    return t;
  }

  unassign(id: string, who: string, by: string): Task {
    const t = this.must(id);
    const i = t.assignees.indexOf(who);
    if (i >= 0) {
      t.assignees.splice(i, 1);
      this.note(by, id, `unassigned ${who}`);
      t.updatedAt = this.now();
    }
    return t;
  }

  label(id: string, label: string, on: boolean, by: string): Task {
    const t = this.must(id);
    const l = normLabel(label);
    if (!l || l.length > 50) throw new TaskError('a label is 1 to 50 characters');
    const has = t.labels.includes(l);
    if (on && !has) {
      if (t.labels.length >= this.o.maxLabels) throw new TaskError(`at most ${this.o.maxLabels} labels`);
      t.labels.push(l);
    } else if (!on && has) t.labels.splice(t.labels.indexOf(l), 1);
    else return t;
    t.updatedAt = this.now();
    this.note(by, id, `${on ? 'added' : 'removed'} label ${l}`);
    return t;
  }

  addChecklist(id: string, text: string, by: string): ChecklistItem {
    const t = this.must(id);
    if (!text.trim() || text.length > 500) throw new TaskError('a checklist item is 1 to 500 characters');
    if (t.checklist.length >= this.o.maxChecklist) throw new TaskError(`at most ${this.o.maxChecklist} checklist items`);
    const n = Math.max(0, ...t.checklist.map((c) => Number(c.id.slice(1)))) + 1;
    const item = { id: `c${n}`, text: text.trim(), done: false };
    t.checklist.push(item);
    t.updatedAt = this.now();
    this.note(by, id, `added checklist item ${item.id}`);
    return item;
  }

  tick(id: string, itemId: string, done: boolean, by: string): ChecklistItem {
    const t = this.must(id);
    const item = t.checklist.find((c) => c.id === itemId);
    if (!item) throw new TaskError(`no checklist item ${itemId}`);
    item.done = done;
    t.updatedAt = this.now();
    this.note(by, id, `${done ? 'ticked' : 'unticked'} ${itemId}`);
    return item;
  }

  /** Done and total counts through subtasks (each leaf counts once, cancelled ones not at all) and checklists. */
  progress(id: string): { done: number; total: number; percent: number } {
    const t = this.must(id);
    let done = 0;
    let total = 0;
    const visit = (x: Task) => {
      const kids = this.children(x.id);
      for (const c of x.checklist) {
        total++;
        if (c.done || x.status === 'done') done++;
      }
      if (kids.length === 0) {
        if (x.status === 'cancelled') return;
        if (x.checklist.length === 0) {
          total++;
          if (x.status === 'done') done++;
        }
      } else kids.forEach(visit);
    };
    visit(t);
    return { done, total, percent: total === 0 ? 0 : Math.round((done / total) * 100) };
  }

  list(f: Filter = {}): Task[] {
    const text = f.text?.toLowerCase();
    return [...this.tasks.values()]
      .filter((t) => (f.status ? f.status.includes(t.status) : true))
      .filter((t) => (f.assignee ? t.assignees.includes(f.assignee) : true))
      .filter((t) => (f.label ? t.labels.includes(normLabel(f.label)) : true))
      .filter((t) => (f.priority ? t.priority === f.priority : true))
      .filter((t) => (f.dueBefore !== undefined ? t.due !== undefined && t.due < f.dueBefore : true))
      .filter((t) => (f.overdueAt !== undefined ? t.due !== undefined && t.due < f.overdueAt && (t.status === 'todo' || t.status === 'doing') : true))
      .filter((t) => (f.parent === undefined ? true : f.parent === null ? t.parent === undefined : t.parent === f.parent))
      .filter((t) => (text ? t.title.toLowerCase().includes(text) || t.notes.toLowerCase().includes(text) : true))
      .sort((a, b) => PRIORITIES.indexOf(b.priority) - PRIORITIES.indexOf(a.priority) || (a.due ?? Infinity) - (b.due ?? Infinity) || (a.id < b.id ? -1 : 1));
  }

  /** Reminders whose time has come and that have not been marked sent; open tasks only. */
  dueReminders(at: number = this.now(), o: { mark?: boolean } = {}): Reminder[] {
    const out: Reminder[] = [];
    for (const t of this.tasks.values()) {
      if (t.due === undefined || (t.status !== 'todo' && t.status !== 'doing')) continue;
      for (const before of t.reminders) {
        const when = t.due - before;
        const key = `${t.id}|${t.due}|${before}`;
        if (when <= at && !this.sent.has(key)) {
          out.push({ task: t.id, title: t.title, due: t.due, at: when, assignees: [...t.assignees] });
          if (o.mark ?? true) this.sent.add(key);
        }
      }
    }
    return out.sort((a, b) => a.at - b.at || (a.task < b.task ? -1 : 1));
  }
}
