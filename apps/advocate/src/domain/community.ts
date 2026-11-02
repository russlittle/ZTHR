import { createHmac, randomBytes, randomUUID } from 'node:crypto';

/**
 * A community that runs itself (PRD COM-1 to COM-5). It is built from typed,
 * located, expiring objects, not open conversation: no feeds, no threads, no
 * follower counts. Every post passes deterministic filters before anyone sees
 * it; student reports hold a post; safety problems go to a person. Members
 * appear under a per-community pseudonym, and contact details are exchanged
 * only when both sides approve.
 */
export type PostType = 'ask' | 'offer' | 'tip' | 'study-group';
export type PostCategory = 'ride' | 'item' | 'food' | 'help' | 'books' | 'study' | 'campus-know-how';

export interface Post {
  id: string;
  type: PostType;
  category: PostCategory;
  college: string;
  communities: string[];
  text: string;
  course?: string;
  when?: { date: string; start?: string; end?: string };
  expires: string;
  author: string; // pseudonym
  status: 'open' | 'matched' | 'closed' | 'held' | 'expired';
  holdReason?: string;
  reports: number;
  ratings: number[];
  createdAt: string;
}

export const COMMUNITIES = ['first-generation', 'student-parents', 'veterans', 'lgbtq', 'adult-learners', 'commuters', 'black-students', 'disabled-students'] as const;

const FILTERS: [RegExp, string][] = [
  [/\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/, 'contains a phone number; contact is shared only when both people agree'],
  [/[\w.+-]+@[\w-]+\.[\w.]+/, 'contains an email address; contact is shared only when both people agree'],
  [/\b\d{2,5}\s+\w+\s+(st|street|ave|avenue|rd|road|dr|drive|blvd|lane|ln)\b/i, 'contains a street address'],
  [/\b(kill|hurt|beat up|shoot)\s+(you|him|her|them)\b/i, 'contains a threat; a person will review it'],
  [/\b(selling|sell|buy)\b.*\b(adderall|xanax|pills|weed|gun|vape)\b|\b(adderall|xanax)\b/i, 'offers something that cannot be traded here'],
  [/\b(venmo|cash ?app|paypal|zelle)\b.*\b(send|pay)\b/i, 'asks for payment; the community is for free help'],
  [/https?:\/\//i, 'contains a link; links can hide scams'],
];
const SAFETY = /\b(kill|hurt|shoot)\b/i;

export interface ModerationResult {
  ok: boolean;
  reasons: string[];
  toPerson: boolean;
}

export function moderate(text: string): ModerationResult {
  const reasons = FILTERS.filter(([re]) => re.test(text)).map(([, why]) => why);
  return { ok: reasons.length === 0 && text.trim().length >= 3 && text.length <= 280, reasons: text.length > 280 ? [...reasons, 'longer than 280 characters'] : reasons, toPerson: SAFETY.test(text) };
}

export class Community {
  private readonly posts = new Map<string, Post>();
  private readonly salt = randomBytes(16);
  private readonly connections: { a: string; b: string; approvedA: boolean; approvedB: boolean; postA: string; postB: string }[] = [];
  readonly personQueue: { postId: string; reason: string }[] = [];

  constructor(private readonly today: () => string) {}

  pseudonym(studentId: string, college: string): string {
    const h = createHmac('sha256', this.salt).update(`${college}:${studentId}`).digest('hex');
    const animals = ['Heron', 'Fox', 'Otter', 'Wren', 'Maple', 'Cedar', 'Finch', 'Lark', 'Birch', 'Robin'];
    return `${animals[parseInt(h.slice(0, 2), 16) % animals.length]} ${parseInt(h.slice(2, 6), 16) % 1000}`;
  }

  post(studentId: string, p: Omit<Post, 'id' | 'author' | 'status' | 'reports' | 'ratings' | 'createdAt'>): Post {
    const m = moderate(p.text);
    const post: Post = {
      ...p,
      id: `post_${randomUUID().slice(0, 8)}`,
      author: this.pseudonym(studentId, p.college),
      status: m.ok ? 'open' : 'held',
      holdReason: m.ok ? undefined : m.reasons.join('; ') || 'too short',
      reports: 0,
      ratings: [],
      createdAt: this.today(),
    };
    this.posts.set(post.id, post);
    this.owner.set(post.id, studentId);
    if (m.toPerson) this.personQueue.push({ postId: post.id, reason: 'possible threat' });
    return post;
  }

  private readonly owner = new Map<string, string>();

  /** What a student sees: open, unexpired posts at their college, filtered by the communities they joined. Never a feed of everything. */
  visible(college: string, opts: { communities?: string[]; type?: PostType; category?: PostCategory; course?: string } = {}): Post[] {
    this.expire();
    return [...this.posts.values()].filter(
      (p) =>
        p.status === 'open' &&
        p.college === college &&
        (!opts.type || p.type === opts.type) &&
        (!opts.category || p.category === opts.category) &&
        (!opts.course || p.course === opts.course) &&
        (p.communities.length === 0 || !opts.communities || p.communities.some((c) => opts.communities!.includes(c))),
    );
  }

  report(postId: string): Post | undefined {
    const p = this.posts.get(postId);
    if (!p) return undefined;
    p.reports += 1;
    if (p.reports >= 2 && p.status === 'open') {
      p.status = 'held';
      p.holdReason = 'reported by two students; waiting for review';
      this.personQueue.push({ postId, reason: 'reported twice' });
    }
    return p;
  }

  rate(postId: string, stars: 1 | 2 | 3 | 4 | 5): void {
    const p = this.posts.get(postId);
    if (!p || p.type !== 'tip') return;
    p.ratings.push(stars);
    const avg = p.ratings.reduce((s, x) => s + x, 0) / p.ratings.length;
    if (p.ratings.length >= 3 && avg < 2.5) {
      p.status = 'closed';
      p.holdReason = 'retired: students rated it unhelpful';
    }
  }

  /** Posts past their expiry close themselves; tips retire after 120 days unless re-verified. */
  expire(): number {
    let n = 0;
    for (const p of this.posts.values()) {
      const stale = p.type === 'tip' ? (Date.parse(this.today()) - Date.parse(p.createdAt)) / 86_400_000 > 120 : p.expires < this.today();
      if (p.status === 'open' && stale) {
        p.status = 'expired';
        n += 1;
      }
    }
    return n;
  }

  /** Asks matched to offers of the same category at the same college, on the same day when a day is given. */
  matches(postId: string): Post[] {
    const p = this.posts.get(postId);
    if (!p || (p.type !== 'ask' && p.type !== 'offer')) return [];
    const want = p.type === 'ask' ? 'offer' : 'ask';
    return this.visible(p.college, { type: want, category: p.category }).filter((o) => !p.when || !o.when || o.when.date === p.when.date);
  }

  /** Both sides must approve before either learns how to reach the other. */
  requestConnection(postA: string, postB: string): number {
    this.connections.push({ a: this.owner.get(postA)!, b: this.owner.get(postB)!, approvedA: true, approvedB: false, postA, postB });
    return this.connections.length - 1;
  }

  approveConnection(index: number, studentId: string): boolean {
    const c = this.connections[index];
    if (!c) return false;
    if (c.b === studentId) c.approvedB = true;
    if (c.a === studentId) c.approvedA = true;
    if (c.approvedA && c.approvedB) {
      for (const id of [c.postA, c.postB]) {
        const p = this.posts.get(id);
        if (p) p.status = 'matched';
      }
      return true;
    }
    return false;
  }

  /** Contact is revealed only for an approved connection, and only to its two members. */
  contactAllowed(index: number, studentId: string): boolean {
    const c = this.connections[index];
    return !!c && c.approvedA && c.approvedB && (c.a === studentId || c.b === studentId);
  }

  /** Study groups form when three or more students ask for the same course. */
  studyGroups(college: string): { course: string; members: string[] }[] {
    const byCourse = new Map<string, string[]>();
    for (const p of this.visible(college, { type: 'study-group' })) if (p.course) byCourse.set(p.course, [...(byCourse.get(p.course) ?? []), p.author]);
    return [...byCourse].filter(([, m]) => m.length >= 3).map(([course, members]) => ({ course, members }));
  }

  get(postId: string): Post | undefined {
    return this.posts.get(postId);
  }

  all(): Post[] {
    return [...this.posts.values()];
  }
}
