/**
 * Writes eval/README.md from the persona fixture and every graded round, so the page can never say something the
 * grades do not. Held-out personas are reported apart: they are graded every round and never used to choose a fix,
 * so their movement is the check against fitting the fixes to the graders.
 *
 *   node tools/eval-report.ts
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';

const at = (p: string) => new URL(`../eval/${p}`, import.meta.url);
interface Persona { id: string; name: string; role: string; screen: string; comesTo: string; heldOut: boolean }
interface Axis { id: string; name: string; asks: string }
const fixture = JSON.parse(readFileSync(at('personas.json'), 'utf8')) as { method: string; axes: Axis[]; scale: Record<string, number>; personas: Persona[] };
type Grades = Record<string, Record<string, [string, string] | string>>;
interface Round { round: number; build: string; walk: string; findings: Record<string, { what: string; axes: string[]; positive?: boolean }>; fixed?: string[]; partly?: string[]; grades: Grades }
const rounds = readdirSync(at('rounds/'))
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(at(`rounds/${f}`), 'utf8')) as Round)
  .sort((a, b) => a.round - b.round);

const score = (g: string) => {
  const v = fixture.scale[g];
  if (v === undefined) throw new Error(`"${g}" is not on the scale`);
  return v;
};
const letter = (v: number) => Object.entries(fixture.scale).reduce((best, [k, s]) => (Math.abs(s - v) < Math.abs(fixture.scale[best]! - v) ? k : best), 'C');
const grade = (r: Round, p: string, a: string) => {
  const x = r.grades[p]?.[a];
  return Array.isArray(x) ? x[0] : undefined;
};
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const personaAvg = (r: Round, p: string) => avg(fixture.axes.map((a) => score(grade(r, p.toString(), a.id)!)));
const axisAvg = (r: Round, a: string, held: boolean) => avg(fixture.personas.filter((p) => p.heldOut === held).map((p) => score(grade(r, p.id, a)!)));
const groupAvg = (r: Round, held: boolean) => avg(fixture.personas.filter((p) => p.heldOut === held).map((p) => personaAvg(r, p.id)));

// Every round grades every persona on every axis, or the page is not written.
for (const r of rounds) for (const p of fixture.personas) for (const a of fixture.axes) if (!grade(r, p.id, a.id)) throw new Error(`round ${r.round} has no grade for ${p.id} on ${a.id}`);

const last = rounds.at(-1)!;
const first = rounds[0]!;
const fmt = (v: number) => v.toFixed(2);
const chart = `\`\`\`mermaid
xychart-beta
  title "Average grade by round (4 = A, 3 = B, 2 = C)"
  x-axis [${rounds.map((r) => `"Round ${r.round}"`).join(', ')}]
  y-axis "Grade points" 0 --> 4
  bar [${rounds.map((r) => fmt(groupAvg(r, false))).join(', ')}]
  line [${rounds.map((r) => fmt(groupAvg(r, true))).join(', ')}]
\`\`\``;
const axisChart = `\`\`\`mermaid
xychart-beta
  title "By axis, driving personas: round ${first.round} to round ${last.round}"
  x-axis [${fixture.axes.map((a) => `"${a.name.split(' ')[0]}"`).join(', ')}]
  y-axis "Grade points" 0 --> 4
  bar [${fixture.axes.map((a) => fmt(axisAvg(first, a.id, false))).join(', ')}]
  bar [${fixture.axes.map((a) => fmt(axisAvg(last, a.id, false))).join(', ')}]
\`\`\``;
const table = (r: Round) =>
  `| Persona | ${fixture.axes.map((a) => a.name).join(' | ')} | Average |\n| --- | ${fixture.axes.map(() => ':---:').join(' | ')} | :---: |\n${fixture.personas
    .map((p) => `| ${p.name}${p.heldOut ? ' *(held out)*' : ''} | ${fixture.axes.map((a) => grade(r, p.id, a.id)).join(' | ')} | ${letter(personaAvg(r, p.id))} |`)
    .join('\n')}`;
const voices = (r: Round) =>
  fixture.personas
    .map((p) => ({ p, v: (r.grades[p.id]?.['voice'] as string | undefined) ?? '' }))
    .filter((x) => x.v)
    .map((x) => `> **${x.p.name}**, ${x.p.role}: "${x.v}"`)
    .join('\n>\n');

const page = `# Persona evaluation

${fixture.method}

${chart}

Bars are the ${fixture.personas.filter((p) => !p.heldOut).length} driving personas; the line is the ${fixture.personas.filter((p) => p.heldOut).length} held out. Driving: ${rounds.map((r) => letter(groupAvg(r, false))).join(' → ')}. Held out: ${rounds.map((r) => letter(groupAvg(r, true))).join(' → ')}.

${axisChart}

## The axes

| Axis | What it asks |
| --- | --- |
${fixture.axes.map((a) => `| ${a.name} | ${a.asks} |`).join('\n')}

## The personas

| Persona | Role | Screen | Comes to |
| --- | --- | --- | --- |
${fixture.personas.map((p) => `| ${p.name}${p.heldOut ? ' *(held out)*' : ''} | ${p.role} | ${p.screen} | ${p.comesTo} |`).join('\n')}

${rounds
  .slice()
  .reverse()
  .map(
    (r) => `## Round ${r.round}

**Build:** ${r.build}. **Walk:** ${r.walk}.${r.fixed?.length ? ` **Closed:** ${r.fixed.join(', ')}.` : ''}${r.partly?.length ? ` **Partly:** ${r.partly.join(', ')}.` : ''}

${table(r)}

${Object.entries(r.findings)
  .map(([id, f]) => `- **${id}**${f.positive ? ' (holds)' : ''}: ${f.what}`)
  .join('\n')}

${voices(r)}
`,
  )
  .join('\n')}`;
writeFileSync(at('README.md'), page);
console.log(`eval/README.md: ${rounds.length} rounds; driving ${rounds.map((r) => fmt(groupAvg(r, false))).join(' → ')}, held out ${rounds.map((r) => fmt(groupAvg(r, true))).join(' → ')}`);
