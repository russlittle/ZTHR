/**
 * Test data that looks real and can never be mistaken for real. A seed gives the same data every run, so a failing
 * test can be repeated. Names come from a wide mix of cultures; email addresses use the reserved example domains
 * (RFC 2606), phone numbers the ranges set aside for fiction (555-0100 to 555-0199 in North America, Ofcom's drama
 * ranges in the UK), and card numbers only the providers' published test numbers. Factories build records with
 * overrides, and a dataset can be built to a shape (so many accounts, each with so many files).
 */

/** Mulberry32: small, fast, and the same everywhere for a seed. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const GIVEN = ['Ana', 'Ben', 'Chioma', 'Dmitri', 'Elif', 'Farah', 'Gabriel', 'Hana', 'Ifeoma', 'Jae-won', 'Kofi', 'Lucía', 'Mateo', 'Nadia', 'Oluwaseun', 'Priya', 'Quang', 'Rania', 'Sione', 'Tomás', 'Uma', 'Valentina', 'Wei', 'Ximena', 'Yusuf', 'Zainab', 'Aroha', 'Björn', 'Siobhán', 'Thandiwe'];
const FAMILY = ['Okafor', 'Nguyen', 'García', 'Müller', 'Khan', 'Smith', 'Tanaka', 'Kowalski', 'Haddad', 'Silva', 'Ivanova', 'Mensah', 'Kim', 'Patel', "O'Brien", 'Yılmaz', 'Cohen', 'Fernández', 'Rossi', 'Abebe', 'Ngata', 'Lindqvist', 'Chen', 'Mbeki'];
const WORDS = ['plan', 'budget', 'notes', 'draft', 'photos', 'report', 'minutes', 'invoice', 'roadmap', 'brief', 'survey', 'contract', 'agenda', 'review'];

export const EMAIL_DOMAINS = ['example.com', 'example.org', 'example.net'] as const;
/** Published card test numbers; none can move money. */
export const TEST_CARDS = { visa: '4242424242424242', visaDebit: '4000056655665556', mastercard: '5555555555554444', amex: '378282246310005', declined: '4000000000000002' } as const;

export class Fake {
  readonly r: () => number;
  private n = 0;
  constructor(seed = 1) {
    this.r = rng(seed);
  }
  int(min: number, max: number): number {
    return min + Math.floor(this.r() * (max - min + 1));
  }
  pick<T>(list: readonly T[]): T {
    return list[Math.floor(this.r() * list.length)]!;
  }
  bool(p = 0.5): boolean {
    return this.r() < p;
  }
  id(prefix = 'id'): string {
    return `${prefix}_${(++this.n).toString(36).padStart(4, '0')}`;
  }
  name(): { given: string; family: string; full: string } {
    const given = this.pick(GIVEN);
    const family = this.pick(FAMILY);
    return { given, family, full: `${given} ${family}` };
  }
  email(name?: string): string {
    const local = (name ?? this.pick(GIVEN)).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.|\.$/g, '') || 'person';
    return `${local}.${this.int(1, 999)}@${this.pick(EMAIL_DOMAINS)}`;
  }
  /** A number in a range reserved for fiction. */
  phone(country: 'US' | 'GB' = 'US'): string {
    return country === 'US' ? `+1${this.pick(['212', '312', '415', '937'])}55501${String(this.int(0, 99)).padStart(2, '0')}` : `+447700900${String(this.int(0, 999)).padStart(3, '0')}`;
  }
  date(from: string, to: string): Date {
    const a = Date.parse(from);
    return new Date(a + Math.floor(this.r() * (Date.parse(to) - a)));
  }
  sentence(words = 8): string {
    const w = Array.from({ length: words }, () => this.pick(WORDS));
    return `${w[0]![0]!.toUpperCase()}${w.join(' ').slice(1)}.`;
  }
  filename(): string {
    return `${this.pick(WORDS)}-${this.int(2019, 2026)}.${this.pick(['pdf', 'docx', 'xlsx', 'png', 'jpg', 'txt'])}`;
  }
}

/** Builds records from defaults, with overrides, and a sequence number that starts at 1 for each Fake. */
export function factory<T>(defaults: (f: Fake, i: number) => T): (f: Fake, overrides?: Partial<T>) => T {
  // Counted per Fake, so a seed gives the same sequence numbers however many records other tests built first.
  const counts = new WeakMap<Fake, number>();
  return (f, overrides = {}) => {
    const i = (counts.get(f) ?? 0) + 1;
    counts.set(f, i);
    return { ...defaults(f, i), ...overrides };
  };
}

/** True only for values that could have come from Fake: the guard a seeding script runs before writing anywhere. */
export function looksFake(v: { email?: string; phone?: string; card?: string }): boolean {
  if (v.email && !EMAIL_DOMAINS.some((d) => v.email!.endsWith(`@${d}`))) return false;
  if (v.phone && !/^\+1\d{3}55501\d{2}$|^\+447700900\d{3}$/.test(v.phone)) return false;
  if (v.card && !(Object.values(TEST_CARDS) as string[]).includes(v.card)) return false;
  return true;
}
