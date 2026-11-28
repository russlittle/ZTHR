/**
 * Re-ranks catalog/top50.json by measurement instead of judgment: the summed npm downloads over the last month
 * of each block's representative libraries. Downloads are a proxy for how many applications need a block; they
 * also count CI runs and installs pulled in by other packages, and the method says so in its output.
 *
 *   node tools/rank-blocks.mjs            (Node 18 or later; needs api.npmjs.org, which Cloud Shell reaches)
 */
import { readFileSync, writeFileSync } from 'node:fs';

const API = 'https://api.npmjs.org/downloads/point/last-month/';
const list = JSON.parse(readFileSync(new URL('../catalog/top50.json', import.meta.url), 'utf8'));
const names = [...new Set(list.blocks.flatMap((b) => b.libraries))].sort();

async function getJson(url) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { headers: { 'user-agent': 'zthr-spec rank-blocks' } });
    if (res.ok) return res.json();
    if (res.status === 404) return null;
    if (attempt >= 3) throw new Error(`${url} answered ${res.status}`);
    await new Promise((r) => setTimeout(r, 2000 * attempt));
  }
}

const downloads = new Map();
// Unscoped names can be asked for together, up to 128 at a time; scoped names one at a time.
const unscoped = names.filter((n) => !n.startsWith('@'));
for (let i = 0; i < unscoped.length; i += 100) {
  const batch = unscoped.slice(i, i + 100);
  const answer = (await getJson(API + batch.join(','))) ?? {};
  for (const n of batch) downloads.set(n, answer[n]?.downloads ?? null);
}
for (const n of names.filter((n) => n.startsWith('@'))) {
  const answer = await getJson(API + encodeURIComponent(n).replace('%40', '@'));
  downloads.set(n, answer?.downloads ?? null);
}

const ranked = list.blocks
  .map((b) => {
    const counts = b.libraries.map((l) => [l, downloads.get(l) ?? null]);
    const known = counts.filter(([, d]) => typeof d === 'number');
    return { ...b, judgedRank: b.rank, monthlyDownloads: known.reduce((s, [, d]) => s + d, 0), libraries: Object.fromEntries(counts), unknownLibraries: counts.filter(([, d]) => d === null).map(([l]) => l) };
  })
  .sort((a, b) => b.monthlyDownloads - a.monthlyDownloads || a.judgedRank - b.judgedRank)
  .map((b, i) => ({ ...b, rank: i + 1 }));

const out = {
  method: 'Summed npm downloads over the last month of each block\'s representative libraries. A proxy: it counts CI runs and installs pulled in by other packages, and a library shared by two blocks counts for both.',
  measuredAt: new Date().toISOString(),
  blocks: ranked,
};
writeFileSync(new URL('../catalog/top50.measured.json', import.meta.url), `${JSON.stringify(out, null, 2)}\n`);
for (const b of ranked) {
  const move = b.judgedRank - b.rank;
  console.log(`${String(b.rank).padStart(2)}. ${b.name.padEnd(36)} ${String(b.monthlyDownloads.toLocaleString()).padStart(14)}  judged ${String(b.judgedRank).padStart(2)} ${move > 0 ? `+${move}` : move < 0 ? `${move}` : ''}`);
}
