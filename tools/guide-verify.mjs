// The guide verifier: every entry in the published community resource guide, re-read at its source. For each entry
// it fetches the source of record and the entry's own page, and checks that each answers, that the phone number the
// guide lists still appears there, and that the entry is within its freshness. Results go to guide-verify.json and
// the run summary. Outside sites fail for reasons that are not the guide's (a timeout, a bot wall), so the run fails
// only when the feed itself is broken; anything it could not confirm is listed for the curator, by entry.
//
//   node tools/guide-verify.mjs [feed=https://zthr.ai/reference/guide/v1/services.json]
import { appendFileSync, writeFileSync } from 'node:fs';

const FEED = process.argv[2] ?? 'https://zthr.ai/reference/guide/v1/services.json';
const UA = 'Mozilla/5.0 (compatible; zthr-guide-verifier; +https://zthr.ai/reference/docs/flows/resource-guide.html)';
const digits = (p) => (p ?? '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');

async function read(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 20_000);
  try {
    const r = await fetch(url, { redirect: 'follow', signal: ctl.signal, headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,*/*' } });
    const body = r.status < 400 ? (await r.text()).slice(0, 2_000_000) : '';
    return { status: r.status, final: r.url, body };
  } catch (e) {
    return { status: 0, final: url, body: '', error: String(e.cause?.code ?? e.name ?? e.message) };
  } finally {
    clearTimeout(t);
  }
}

const res = await fetch(FEED, { headers: { 'user-agent': UA } });
if (!res.ok) {
  console.error(`the feed answered ${res.status}`);
  process.exit(1);
}
const feed = await res.json();
if (!Array.isArray(feed.services) || feed.services.length === 0) {
  console.error('the feed has no services');
  process.exit(1);
}

const today = new Date().toISOString().slice(0, 10);
const cache = new Map();
const once = (u) => {
  if (!cache.has(u)) cache.set(u, read(u));
  return cache.get(u);
};
const results = [];
// A few at a time, so no site sees more than a handful of requests.
for (let i = 0; i < feed.services.length; i += 6) {
  const batch = feed.services.slice(i, i + 6);
  results.push(
    ...(await Promise.all(
      batch.map(async (s) => {
        const src = await once(s.source.url);
        const page = s.url && s.url !== s.source.url ? await once(s.url) : src;
        const answered = src.status > 0 && src.status < 400;
        const pageAnswered = page.status > 0 && page.status < 400;
        const d = digits(s.phone);
        const phoneSeen = !d || d.length < 10 ? null : [src.body, page.body].some((b) => digits(b).includes(d));
        const age = Math.round((Date.parse(today) - Date.parse(s.verification.verified_on)) / 86_400_000);
        const notes = [];
        if (!answered) notes.push(`source answered ${src.status || src.error}`);
        if (!pageAnswered && page !== src) notes.push(`page answered ${page.status || page.error}`);
        if (answered && phoneSeen === false) notes.push('the listed phone number was not found on the source or page');
        if (age > s.verification.freshness_days) notes.push(`last verified ${age} days ago, past its ${s.verification.freshness_days}-day freshness`);
        return { id: s.id, name: s.name, source: s.source.url, source_status: src.status, page_status: page.status, phone_seen: phoneSeen, age_days: age, status: notes.length ? 'needs a look' : 'confirmed', notes };
      }),
    )),
  );
}

const confirmed = results.filter((r) => r.status === 'confirmed').length;
const report = { feed: FEED, at: new Date().toISOString(), entries: results.length, confirmed, needs_a_look: results.length - confirmed, sources_answered: results.filter((r) => r.source_status > 0 && r.source_status < 400).length, phones_seen: results.filter((r) => r.phone_seen === true).length, phones_checked: results.filter((r) => r.phone_seen !== null).length, results };
writeFileSync('guide-verify.json', JSON.stringify(report, null, 1));
const lines = [`## Guide verification`, '', `${confirmed} of ${results.length} entries confirmed at their sources. Sources answered: ${report.sources_answered}. Phone numbers found on the source: ${report.phones_seen} of ${report.phones_checked}.`, ''];
const look = results.filter((r) => r.status !== 'confirmed');
if (look.length) lines.push('| Entry | What to look at |', '|---|---|', ...look.map((r) => `| ${r.name} (\`${r.id}\`) | ${r.notes.join('; ')} |`));
console.log(lines.join('\n'));
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
