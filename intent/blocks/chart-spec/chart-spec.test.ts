import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChartSpecError, PALETTE, altText, bandScale, formatNumber, linearScale, luminance, mixColor, niceTicks, renderChart, timeTicks } from './index.ts';
import type { ChartSpec } from './index.ts';

function wellFormed(xml: string): void {
  const stack: string[] = [];
  const re = /<(\/?)([A-Za-z][\w:-]*)((?:\s+[\w:-]+="[^"<]*")*)\s*(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  let consumed = 0;
  while ((m = re.exec(xml))) {
    consumed += m[0].length;
    if (m[5] !== undefined) {
      assert.ok(!/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;)/.test(m[5]), `bare ampersand: ${m[5]}`);
      continue;
    }
    if (m[1]) assert.equal(stack.pop(), m[2], `mismatched </${m[2]}>`);
    else if (!m[4]) stack.push(m[2]!);
  }
  assert.equal(consumed, xml.length);
  assert.deepEqual(stack, []);
}

const months = [{ m: '2024-01-01', a: 3, b: 5 }, { m: '2024-02-01', a: 5, b: 4 }, { m: '2024-03-01', a: 9, b: null }, { m: '2024-04-01', a: 7, b: 8 }];
const line = { type: 'line', title: 'Sales', data: months, x: { field: 'm', label: 'Month' }, y: { label: 'Units' }, series: [{ field: 'a', label: 'Alpha' }, { field: 'b', label: 'Beta' }] } as const satisfies ChartSpec;

test('nice ticks: round steps covering the range, in the classic cases', () => {
  assert.deepEqual(niceTicks(0, 97, 5).ticks, [0, 20, 40, 60, 80, 100]);
  assert.deepEqual(niceTicks(-3, 3.2, 5).ticks, [-4, -2, 0, 2, 4]);
  assert.deepEqual(niceTicks(0.12, 0.47, 5).ticks, [0.1, 0.2, 0.3, 0.4, 0.5]);
  assert.deepEqual(niceTicks(1, 1_000_000, 5).ticks, [0, 200000, 400000, 600000, 800000, 1000000]);
  assert.deepEqual(niceTicks(0, 0).ticks, [0, 0.2, 0.4, 0.6, 0.8, 1]);
  const flat = niceTicks(5, 5);
  assert.ok(flat.min < 5 && flat.max > 5, 'a flat range is widened');
  assert.deepEqual(niceTicks(10, 0, 3).ticks, [0, 5, 10], 'the arguments may come in either order');
  assert.throws(() => niceTicks(0, Number.NaN), ChartSpecError);
});

test('time ticks fall on the calendar: hours, days, months and years in UTC', () => {
  const hours = timeTicks(Date.UTC(2024, 0, 1, 0, 10), Date.UTC(2024, 0, 1, 12, 0));
  assert.deepEqual(hours.ticks.map(hours.format), ['03:00', '06:00', '09:00', '12:00']);
  assert.ok(hours.ticks.every((t) => t % 3_600_000 === 0), 'whole hours');
  const days = timeTicks(Date.UTC(2024, 0, 1), Date.UTC(2024, 0, 6));
  assert.equal(days.step, '1 day');
  assert.equal(days.format(days.ticks[0]!), 'Jan 1');
  const months = timeTicks(Date.UTC(2024, 0, 1), Date.UTC(2024, 5, 1));
  assert.deepEqual(months.ticks.map(months.format), ['Jan 2024', 'Feb 2024', 'Mar 2024', 'Apr 2024', 'May 2024', 'Jun 2024']);
  const quarters = timeTicks(Date.UTC(2023, 1, 15), Date.UTC(2025, 5, 1));
  assert.ok(quarters.ticks.every((t) => new Date(t).getUTCDate() === 1 && new Date(t).getUTCMonth() % 6 === 0), 'first of January and July');
  const years = timeTicks(Date.UTC(1990, 0, 1), Date.UTC(2024, 0, 1));
  assert.equal(years.step, '5 years');
  assert.deepEqual(years.ticks.map(years.format), ['1990', '1995', '2000', '2005', '2010', '2015', '2020']);
  assert.throws(() => timeTicks(5, 1), /ordered/);
});

test('scales: linear mapping and inversion, bands with padding, and unknown keys refused', () => {
  const s = linearScale(0, 10, 100, 0);
  assert.equal(s(0), 100);
  assert.equal(s(10), 0);
  assert.equal(s(2.5), 75);
  assert.equal(linearScale(5, 5, 0, 10)(5), 5, 'a flat domain maps to the middle');
  const b = bandScale(['a', 'b', 'c', 'd'], 0, 100, 0.2);
  assert.deepEqual(b('b'), { start: 27.5, width: 20, center: 37.5 });
  assert.throws(() => b('z'), /not in the scale/);
});

test('colours: mixing, luminance and a palette that stays readable on white', () => {
  assert.equal(mixColor('#000000', '#ffffff', 0.5), '#808080');
  assert.equal(mixColor('#ff0000', '#0000ff', 0), '#ff0000');
  assert.equal(mixColor('#ff0000', '#0000ff', 2), '#0000ff', 't is clamped');
  assert.throws(() => mixColor('red', '#fff', 0.5), /not a #rrggbb/);
  assert.equal(luminance('#ffffff'), 1);
  assert.equal(luminance('#000000'), 0);
  const contrast = (c: string) => 1.05 / (luminance(c) + 0.05);
  for (const c of PALETTE.slice(0, 5)) assert.ok(contrast(c) >= 3, `${c} has contrast ${contrast(c).toFixed(2)} on white`);
  assert.equal(new Set(PALETTE).size, PALETTE.length);
});

test('number formats: compact by default for large values, integer, percent and decimal, in a locale', () => {
  assert.equal(formatNumber(1234.5678), '1,234.57');
  assert.equal(formatNumber(12_345), '12.3K');
  assert.equal(formatNumber(2_500_000), '2.5M');
  assert.equal(formatNumber(0.256, 'percent'), '25.6%');
  assert.equal(formatNumber(1234.6, 'integer'), '1,235');
  assert.equal(formatNumber(1.2345, 'decimal'), '1.23');
  assert.equal(formatNumber(1234.5, 'auto', 'de-DE'), '1.234,5');
  assert.equal(formatNumber(Number.NaN), 'NaN');
});

test('a line chart carries a title, a generated description, and a value on every point', () => {
  const svg = renderChart(line);
  wellFormed(svg);
  assert.match(svg, /<title id="title">Sales<\/title>/);
  assert.match(svg, /<desc id="desc">Line chart titled "Sales"\. 2 series \(Alpha and Beta\) over 4 points from 2024-01-01 to 2024-04-01\. Alpha rises from 3 to 7, peaking at 9 at 2024-03-01 and lowest at 3 at 2024-01-01\./);
  assert.match(svg, /<circle [^>]*><title>Alpha, 2024-03-01: 9<\/title><\/circle>/);
  assert.match(svg, /<title>Beta, 2024-04-01: 8<\/title>/);
  assert.equal((svg.match(/<circle /g) ?? []).length, 7, 'the missing Beta value draws no point');
  assert.match(svg, />Month</);
  assert.match(svg, />Units</);
  assert.match(svg, /Alpha<\/text>/, 'the legend names each series');
});

test('a missing value breaks the line instead of bridging it', () => {
  const gap = renderChart({ ...line, data: [{ m: '2024-01-01', a: 1 }, { m: '2024-02-01', a: 2 }, { m: '2024-03-01', a: null }, { m: '2024-04-01', a: 4 }, { m: '2024-05-01', a: 5 }], series: [{ field: 'a' }] });
  const paths = [...gap.matchAll(/<path d="(M[^"]*)" fill="none"/g)].map((m) => m[1]!);
  assert.equal(paths.length, 2, 'two separate runs');
  assert.equal((paths[0]!.match(/L/g) ?? []).length, 1);
  assert.equal((paths[1]!.match(/L/g) ?? []).length, 1);
});

test('the same chart twice is byte-identical, and long-form data split by a field gives one series per value', () => {
  assert.equal(renderChart(line), renderChart(line));
  const long: ChartSpec = { type: 'line', title: 'By region', x: { field: 'q' }, series: { by: 'region', value: 'sales' }, data: [{ q: 1, region: 'EU', sales: 10 }, { q: 2, region: 'EU', sales: 12 }, { q: 1, region: 'US', sales: 7 }, { q: 2, region: 'US', sales: 3 }] };
  const d = altText(long);
  assert.match(d, /2 series \(EU and US\) over 2 points from 1 to 2/);
  assert.match(d, /US falls from 7 to 3/);
});

test('bars: grouped side by side, stacked to a total, negatives hanging below zero, a title on every bar', () => {
  const data = [{ k: 'A', s1: 2, s2: 3 }, { k: 'B', s1: 4, s2: -1 }];
  const base = { type: 'bar', title: 'Bars', data, x: { field: 'k' }, series: [{ field: 's1', label: 'One' }, { field: 's2', label: 'Two' }] } as const;
  const rects = (svg: string, color: string) => [...svg.matchAll(new RegExp(`<rect x="([\\d.]+)" y="([\\d.]+)" width="([\\d.]+)" height="([\\d.]+)" fill="${color}"><title>([^<]*)</title>`, 'g'))].map((m) => ({ x: +m[1]!, y: +m[2]!, w: +m[3]!, h: +m[4]!, t: m[5]! }));
  const grouped = renderChart(base);
  wellFormed(grouped);
  const one = rects(grouped, '#0072B2');
  const two = rects(grouped, '#D55E00');
  assert.deepEqual(one.map((r) => r.t), ['One, A: 2', 'One, B: 4']);
  assert.ok(two[0]!.x > one[0]!.x, 'the second series sits right of the first');
  assert.ok(Math.abs(one[1]!.h / one[0]!.h - 2) < 0.01, 'a bar of 4 is twice a bar of 2');
  assert.ok(two[1]!.y > one[1]!.y + one[1]!.h - 0.6, 'the negative bar starts at the zero line and goes down');
  const stacked = renderChart({ ...base, stack: true });
  const s1 = rects(stacked, '#0072B2');
  const s2 = rects(stacked, '#D55E00');
  assert.ok(Math.abs(s1[0]!.y - (s2[0]!.y + s2[0]!.h)) < 0.01, 'two sits on top of one');
  assert.ok(Math.abs(s2[0]!.h / s1[0]!.h - 1.5) < 0.01, '3 on top of 2');
  assert.equal(s1[0]!.x, s2[0]!.x, 'stacked bars share a column');
});

test('an area chart fills to the baseline; stacked areas share edges', () => {
  const spec: ChartSpec = { type: 'area', title: 'Area', x: { field: 'x' }, series: [{ field: 'a' }, { field: 'b' }], data: [{ x: 1, a: 1, b: 2 }, { x: 2, a: 2, b: 2 }, { x: 3, a: 3, b: 1 }] };
  const plain = renderChart(spec);
  assert.match(plain, /fill-opacity="0.35"/);
  const stacked = renderChart({ ...spec, stack: true });
  assert.match(stacked, /fill-opacity="0.85"/);
  assert.match(stacked, /Area chart titled "Area"\./);
  wellFormed(plain);
  wellFormed(stacked);
});

test('a pie: slices add to a full turn, each says its value and share, and the description names the largest', () => {
  const spec: ChartSpec = { type: 'pie', title: 'Browsers', category: 'b', value: 'n', data: [{ b: 'Chrome', n: 60 }, { b: 'Safari', n: 25 }, { b: 'Firefox', n: 10 }, { b: 'Other', n: 5 }] };
  const svg = renderChart(spec);
  wellFormed(svg);
  assert.match(svg, /<title>Chrome: 60 \(60%\)<\/title>/);
  assert.match(svg, /<title>Other: 5 \(5%\)<\/title>/);
  assert.equal((svg.match(/<path d="M[^"]*A/g) ?? []).length, 4);
  assert.match(altText(spec), /4 slices\. Largest: Chrome 60%; Safari 25%; Firefox 10%; 1 more\. Smallest: Other 5%\./);
  const single = renderChart({ ...spec, data: [{ b: 'All', n: 5 }] });
  assert.match(single, /<circle [^>]*r="[\d.]+"[^>]*><title>All: 5 \(100%\)<\/title>/);
  assert.match(renderChart({ ...spec, donut: true, data: [{ b: 'All', n: 5 }] }), /fill-rule="evenodd"/);
  assert.match(renderChart({ ...spec, donut: true }), /L[\d. ]+A[\d. ]+ 0 [01] 0 /, 'a donut slice returns along the inner edge');
});

test('a pie refuses negative values and too many slices, and says when everything is zero', () => {
  const base = { type: 'pie', title: 'P', category: 'k', value: 'v' } as const;
  assert.throws(() => renderChart({ ...base, data: [{ k: 'a', v: -1 }] }), /cannot be negative/);
  assert.throws(() => renderChart({ ...base, data: Array.from({ length: 9 }, (_, i) => ({ k: `s${i}`, v: 1 })) }), /at most 8 slices/);
  assert.match(renderChart({ ...base, data: [{ k: 'a', v: 0 }] }), />No data</);
  assert.match(altText({ ...base, data: [{ k: 'a', v: 0 }] }), /All values are zero/);
});

test('a heatmap shades by value, tells each cell in a title, and puts the extremes in the description', () => {
  const data = [{ d: 'Mon', h: '9', n: 1 }, { d: 'Tue', h: '9', n: 5 }, { d: 'Mon', h: '10', n: 9 }, { d: 'Tue', h: '10', n: 5 }];
  const spec: ChartSpec = { type: 'heatmap', title: 'Visits', x: { field: 'd', label: 'Day' }, y: { field: 'h', label: 'Hour' }, value: { field: 'n', label: 'Visits' }, data, colors: ['#ffffff', '#000000'] };
  const svg = renderChart(spec);
  wellFormed(svg);
  assert.match(svg, /<rect [^>]*fill="#ffffff"[^>]*><title>Mon, 9: 1<\/title>/);
  assert.match(svg, /<rect [^>]*fill="#000000"[^>]*><title>Mon, 10: 9<\/title>/);
  assert.match(svg, /<rect [^>]*fill="#808080"[^>]*><title>Tue, 9: 5<\/title>/);
  assert.match(altText(spec), /Highest: 9 at Mon, 10\. Lowest: 1 at Mon, 9\./);
  assert.match(svg, /<linearGradient id="scale"/);
});

test('a table has table, row and cell roles, aligns numbers right, and truncates long text with the whole in a title', () => {
  const spec: ChartSpec = { type: 'table', title: 'Top pages', columns: [{ field: 'page', label: 'Page' }, { field: 'views', label: 'Views' }], data: [{ page: '/home', views: 12_345 }, { page: `/${'very-long-path/'.repeat(30)}`, views: 7 }], width: 400 };
  const svg = renderChart(spec);
  wellFormed(svg);
  assert.match(svg, /role="table" aria-label="Top pages"/);
  assert.equal((svg.match(/role="row"/g) ?? []).length, 3);
  assert.equal((svg.match(/role="columnheader"/g) ?? []).length, 2);
  assert.equal((svg.match(/role="cell"/g) ?? []).length, 4);
  assert.match(svg, />12\.3K</);
  assert.match(svg, /text-anchor="end"[^>]*>12\.3K</);
  assert.match(svg, /…<\/text><title>\/very-long-path/);
  assert.match(altText(spec), /2 of 2 rows and 2 columns: Page and Views\./);
  assert.match(renderChart({ ...spec, maxRows: 1 }), /Top pages/);
  assert.equal((renderChart({ ...spec, maxRows: 1 }).match(/role="row"/g) ?? []).length, 2);
});

test('empty data draws a "No data" chart that is still titled and described, and never throws', () => {
  for (const type of ['line', 'bar', 'area'] as const) {
    const svg = renderChart({ type, title: 'Empty', data: [], x: { field: 'x' }, series: [{ field: 'y' }] });
    assert.match(svg, />No data</);
    assert.match(svg, /<title id="title">Empty<\/title>/);
    assert.match(svg, /There is no data\./);
    wellFormed(svg);
  }
  assert.match(renderChart({ type: 'table', title: 'T', data: [], columns: [{ field: 'a' }] }), /role="table"/);
});

test('bad specs are refused with plain messages: fields, numbers, sizes, series counts and hostile text', () => {
  const ok = { type: 'bar', title: 'T', x: { field: 'k' }, series: [{ field: 'v' }] } as const;
  assert.throws(() => renderChart({ ...ok, title: ' ', data: [] }), /needs a title/);
  assert.throws(() => renderChart({ ...ok, data: [{ k: 'a', w: 1 }] }), /no row has the field "v"/);
  assert.throws(() => renderChart({ ...ok, data: [{ k: 'a', v: Number.NaN }] }), /row 1: "v" is not a finite number/);
  assert.throws(() => renderChart({ ...ok, data: [{ k: 'a', v: 'x' }] }), /not a finite number/);
  assert.throws(() => renderChart({ ...ok, data: [{ k: 'a', v: 1 }], width: 50 }), /width must be between/);
  assert.throws(() => renderChart({ ...ok, data: Array.from({ length: 20_001 }, () => ({ k: 'a', v: 1 })) }), /at most 20000 rows/);
  assert.throws(() => renderChart({ ...ok, data: [{ k: 'a', v: 1 }], series: [] }), /at least one series/);
  assert.throws(() => renderChart({ ...ok, data: [{ k: 'a', v: 1 }], series: Array.from({ length: 9 }, () => ({ field: 'v' })) }), /more than 8 series need colours/);
  assert.throws(() => renderChart({ ...ok, data: [{ k: 'a', v: 1 }], type: 'sparkle' } as never), /not a chart type/);
  assert.throws(() => renderChart({ type: 'line', title: 'T', x: { field: 'x', type: 'time' }, series: [{ field: 'y' }], data: [{ x: 'tomorrow-ish', y: 1 }] }), /not a date or a time/);
  const hostile = renderChart({ ...ok, title: '</title><script>alert(1)</script>', data: [{ k: '<b>&"x"</b>', v: 1 }] });
  assert.ok(!hostile.includes('<script>') && !hostile.includes('<b>'));
  wellFormed(hostile);
});

test('category labels are thinned so they do not overlap, and numeric x axes get nice ticks', () => {
  const cats = Array.from({ length: 40 }, (_, i) => ({ k: `Category number ${i}`, v: i }));
  const svg = renderChart({ type: 'bar', title: 'Many', x: { field: 'k' }, series: [{ field: 'v' }], data: cats });
  const shown = (svg.match(/Category number \d+<\/text>/g) ?? []).length;
  assert.ok(shown > 2 && shown < 20, `${shown} labels shown of 40`);
  assert.equal((svg.match(/<title>v, Category number \d+: \d+<\/title>/g) ?? []).length, 40, 'every bar still has its own title, thinned labels or not');
  const num = renderChart({ type: 'line', title: 'N', x: { field: 'x' }, series: [{ field: 'y' }], data: [{ x: 0, y: 1 }, { x: 97, y: 5 }] });
  assert.deepEqual([...num.matchAll(/text-anchor="middle"[^>]*>(\d+)<\/text>/g)].map((m) => m[1]), ["0", "20", "40", "60", "80"], "x ticks are round numbers inside the data range");
});
