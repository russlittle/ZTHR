/**
 * Books for less (PRD BK-1): the cheapest route to each required material,
 * free first. Links are searches on public sites; no affiliate revenue.
 */
export interface Material {
  course: string;
  title: string;
  author?: string;
  isbn?: string;
  neededBy?: string;
}

export interface BookOption {
  kind: 'library' | 'open-textbook' | 'rental-or-used' | 'campus';
  label: string;
  url?: string;
  cost: 'free' | 'varies';
}

const OPENSTAX: [RegExp, string][] = [
  [/\b(psych|psy)\b/i, 'https://openstax.org/details/books/psychology-2e'],
  [/\b(soc|sociology)\b/i, 'https://openstax.org/details/books/introduction-sociology-3e'],
  [/\b(bio|biology)\b/i, 'https://openstax.org/details/books/biology-2e'],
  [/\b(chem|chemistry)\b/i, 'https://openstax.org/details/books/chemistry-2e'],
  [/\b(econ|economics)\b/i, 'https://openstax.org/details/books/principles-economics-3e'],
  [/\b(stat|statistics)\b/i, 'https://openstax.org/details/books/introductory-statistics-2e'],
  [/\b(anatomy|a&p|bio\s*1[12]1)\b/i, 'https://openstax.org/details/books/anatomy-and-physiology-2e'],
];

export function bookOptions(m: Material, college?: string): BookOption[] {
  const q = encodeURIComponent(m.isbn ?? `${m.title} ${m.author ?? ''}`.trim());
  const opts: BookOption[] = [
    { kind: 'library', label: 'Check libraries near you for a free copy', url: `https://search.worldcat.org/search?q=${q}`, cost: 'free' },
    { kind: 'campus', label: 'Ask the campus library whether the instructor put a copy on reserve', cost: 'free' },
  ];
  const oer = OPENSTAX.find(([re]) => re.test(`${m.course} ${m.title}`));
  if (oer) opts.push({ kind: 'open-textbook', label: 'A free open textbook covers this subject; ask your instructor if it works for the class', url: oer[1], cost: 'free' });
  opts.push({ kind: 'rental-or-used', label: 'Compare used and rental prices', url: `https://www.bookfinder.com/search/?keywords=${q}`, cost: 'varies' });
  if (college === 'sinclair') opts.push({ kind: 'campus', label: 'If money is the blocker, the Sinclair Emergency Grant and case management can help', url: 'https://sinclair.edu/emergencygrant', cost: 'free' });
  return opts;
}
