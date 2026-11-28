import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SubtitleError, activeAt, assColour, burnInPlan, changeFrameRate, cleanText, convert, decodeBytes, detect, ffmpegEscape, formatTime, forceStyle, merge, overlaps, parse, parseAss, parseAssColour, parseMarkup, parseSrt, parseTime,
  parseTtml, parseTtmlTime, parseVtt, plainText, repair, shift, stretch, subtitlesFilter, syncTwoPoints, toAss, toMarkup, toSrt, toTtml, toVtt, write,
} from './index.ts';
import type { Doc, Format } from './index.ts';

const SRT = '﻿1\r\n00:00:01,000 --> 00:00:03,500\r\nHello, <i>world</i> &amp; all\r\n\r\n2\r\n00:00:04.5 --> 00:00:06,000\r\nLine one\r\nLine two\r\n\r\n3\r\n00:01:00,000 --> 00:01:02,000\r\n<font color="red">Red</font> and <b>bold <u>both</u></b>\r\n';

test('parseTime: forms, fractions and limits', () => {
  assert.equal(parseTime('00:00:01,000'), 1000);
  assert.equal(parseTime('01:02:03.456'), 3_723_456);
  assert.equal(parseTime('02:03.5'), 123_500);
  assert.equal(parseTime('00:00:01,5'), 1500);
  assert.equal(parseTime('x'), undefined);
  assert.equal(parseTime('1:99:00,000'), undefined);
  assert.equal(formatTime(3_723_456, ','), '01:02:03,456');
  assert.equal(formatTime(-5), '00:00:00.000');
});

test('markup: canonical, nested, entities, unknown tags dropped, lone < kept', () => {
  assert.equal(cleanText('a < b & c'), 'a &lt; b &amp; c');
  assert.equal(plainText({ text: cleanText('a < b & c') }), 'a < b & c');
  assert.equal(cleanText('<b>x</i><i>y</b>z'), '<b>x</b><b><i>y</i></b><i>z</i>');
  assert.equal(cleanText('<c.yellow>hi</c> <v Bob>there</v> <00:00:01.000>now'), 'hi there now');
  assert.equal(cleanText('<font color="#F00">x</font>'), '<font color="#ff0000">x</font>');
  assert.equal(cleanText('<font color="notacolour">x</font>'), 'x');
  assert.equal(cleanText('&nbsp;&#65;&#x42;&unknown;'), ' AB&amp;unknown;');
  assert.equal(cleanText('<b>unclosed'), '<b>unclosed</b>');
  assert.equal(cleanText('<b>a\nb</b>'), '<b>a</b>\n<b>b</b>');
  const runs = parseMarkup('<b>a<i>b</i></b>c');
  assert.deepEqual(runs.map((r) => [r.text, r.bold, r.italic]), [['a', true, false], ['b', true, true], ['c', false, false]]);
  assert.equal(toMarkup(runs), '<b>a</b><b><i>b</i></b>c');
});

test('SRT: BOM, CRLF, odd times, tags, and a round trip', () => {
  const d = parseSrt(SRT);
  assert.equal(d.cues.length, 3);
  assert.deepEqual([d.cues[0]!.start, d.cues[0]!.end], [1000, 3500]);
  assert.equal(d.cues[0]!.text, 'Hello, <i>world</i> &amp; all');
  assert.equal(d.cues[1]!.start, 4500);
  assert.equal(d.cues[1]!.text, 'Line one\nLine two');
  assert.equal(d.cues[2]!.text, '<font color="#ff0000">Red</font> and <b>bold </b><b><u>both</u></b>');
  assert.deepEqual(parseSrt(toSrt(d)).cues, d.cues);
  assert.match(toSrt(d), /^1\n00:00:01,000 --> 00:00:03,500\n/);
});

test('SRT: bad blocks warn and the rest survives; missing blank lines and indexes cope', () => {
  const d = parseSrt('1\n00:00:01,000 --> 00:00:02,000\nA\n2\n00:00:03,000 --> 00:00:04,000\nB\n\n3\nxx --> yy\nlost\n\n00:00:05,000 --> 00:00:06,000\nC\n');
  assert.deepEqual(d.cues.map((c) => plainText(c)), ['A', 'B', 'C']);
  assert.equal(d.warnings.length, 1);
  assert.equal(parseSrt('nothing here').warnings[0], 'no cues were found');
  assert.throws(() => parseSrt(SRT, { maxCues: 2 }), /more than 2 cues/);
  assert.throws(() => parseSrt('x'.repeat(100), { maxBytes: 10 }), SubtitleError);
});

const VTT = `WEBVTT - A title

NOTE this is ignored
over two lines

STYLE
::cue { color: red }

intro
00:01.000 --> 00:03.000 align:left line:10%
<v Ann>Hello <c.loud>there</c>

00:00:04.000 --> 00:00:05.500
Second &lt;cue&gt;
`;

test('VTT: header, notes, ids, short times, settings, voice tags', () => {
  const d = parseVtt(VTT);
  assert.equal(d.meta.title, 'A title');
  assert.equal(d.cues.length, 2);
  assert.equal(d.cues[0]!.id, 'intro');
  assert.deepEqual([d.cues[0]!.start, d.cues[0]!.end], [1000, 3000]);
  assert.equal(d.cues[0]!.text, 'Hello there');
  assert.equal(d.cues[0]!.align, 7);
  assert.equal(d.cues[0]!.y, 10);
  assert.equal(d.cues[1]!.text, 'Second &lt;cue&gt;');
  assert.equal(d.cues[1]!.align, undefined);
  assert.throws(() => parseVtt('1\n00:00:01.000 --> 00:00:02.000\nx'), /starts with WEBVTT/);
});

test('VTT: write then read back, with positions and colours', () => {
  const d = parseSrt(SRT);
  const d2 = { ...d, cues: [{ ...d.cues[0]!, align: 9, x: 80, y: 5, id: 'a1' }, ...d.cues.slice(1)] };
  const v = toVtt(d2);
  assert.match(v, /^WEBVTT\n\na1\n00:00:01\.000 --> 00:00:03\.500 line:5% position:80% align:right\n/);
  const back = parseVtt(v);
  assert.equal(back.cues.length, 3);
  assert.equal(back.cues[0]!.id, 'a1');
  assert.equal(back.cues[0]!.align, 9);
  assert.equal(plainText(back.cues[1]!), 'Line one\nLine two');
});

const ASS = `[Script Info]
Title: Test
PlayResX: 640
PlayResY: 360

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,28,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,1,2,10,10,20,1
Style: Sign,Impact,40,&H0000FFFF,&H000000FF,&H00112233,&H00000000,-1,0,0,0,100,100,0,0,1,3,0,8,10,10,15,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.50,Default,,0,0,0,,Hello, {\\i1}world{\\i0}\\Nsecond line
Dialogue: 0,0:00:04.00,0:00:05.00,Sign,,0,0,0,,{\\an9\\pos(320,36)}{\\c&H0000FF&}Red{\\r} normal
Dialogue: 0,0:00:06.00,0:00:07.00,Default,,0,0,0,,{\\p1}m 0 0 l 10 10{\\p0}
Comment: 0,0:00:08.00,0:00:09.00,Default,,0,0,0,,not a dialogue
`;

test('ASS: styles, colours in BGR order, commas in text, overrides, drawings dropped', () => {
  const d = parseAss(ASS);
  assert.equal(d.meta.title, 'Test');
  assert.deepEqual([d.meta.playResX, d.meta.playResY], [640, 360]);
  assert.deepEqual(d.styles.get('Sign'), { name: 'Sign', fontName: 'Impact', fontSize: 40, bold: true, italic: false, underline: false, colour: '#ffff00', outlineColour: '#332211', backColour: '#000000', outline: 3, shadow: 0, align: 8, marginL: 10, marginR: 10, marginV: 15 });
  assert.equal(d.cues.length, 2);
  assert.equal(d.cues[0]!.text, 'Hello, <i>world</i>\nsecond line');
  assert.deepEqual([d.cues[0]!.start, d.cues[0]!.end], [1000, 3500]);
  assert.equal(d.cues[1]!.text, '<font color="#ff0000">Red</font> normal');
  assert.equal(d.cues[1]!.align, 9);
  assert.deepEqual([d.cues[1]!.x, d.cues[1]!.y], [50, 10]);
  assert.equal(d.cues[1]!.style, 'Sign');
});

test('ASS colours: BGR, alpha is inverted, decimal and short forms', () => {
  assert.deepEqual(parseAssColour('&H0000FF&'), { colour: '#ff0000', opacity: 1 });
  assert.deepEqual(parseAssColour('&H80FF0000'), { colour: '#0000ff', opacity: 1 - 128 / 255 });
  assert.deepEqual(parseAssColour('16711680'), { colour: '#0000ff', opacity: 1 });
  assert.equal(parseAssColour('blue'), undefined);
  assert.equal(assColour('#ff0000'), '&H000000FF');
  assert.equal(assColour('#112233', 0.5), '&H80332211');
});

test('ASS: write then read keeps text, styling, position and alignment', () => {
  const src = parseAss(ASS);
  const back = parseAss(toAss(src));
  assert.deepEqual(back.cues.map((c) => [c.start, c.end, c.text, c.align]), src.cues.map((c) => [c.start, c.end, c.text, c.align]));
  assert.equal(back.cues[1]!.x, 50);
  assert.equal(back.styles.get('Sign')!.fontName, 'Impact');
  const odd = toAss({ cues: [{ start: 0, end: 1000, text: 'a {b} &amp; c' }], styles: new Map(), meta: {}, warnings: [] });
  assert.match(odd, /,a \(b\) & c/);
});

test('old SSA alignment numbers are converted', () => {
  const ssa = '[Script Info]\n\n[V4 Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, Alignment\nStyle: Top,Arial,20,&H00FFFFFF,6\nStyle: Mid,Arial,20,&H00FFFFFF,10\nStyle: Bot,Arial,20,&H00FFFFFF,2\n\n[Events]\nFormat: Start, End, Style, Text\nDialogue: 0:00:01.00,0:00:02.00,Top,x\n';
  const d = parseAss(ssa);
  assert.deepEqual([d.styles.get('Top')!.align, d.styles.get('Mid')!.align, d.styles.get('Bot')!.align], [8, 5, 2]);
});

const TTML = `<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml" xmlns:tts="http://www.w3.org/ns/ttml#styling" xmlns:ttp="http://www.w3.org/ns/ttml#parameter" xml:lang="fr" ttp:frameRate="25">
<head><styling><style xml:id="em" tts:fontStyle="italic" tts:color="yellow"/></styling></head>
<body><div begin="00:01:00.000">
<p xml:id="p1" begin="00:00:01.000" end="00:00:03.000">Bonjour <span style="em">le monde</span><br/>deuxieme &amp; ligne</p>
<p begin="00:00:05:12" dur="2s" tts:textAlign="right"><span tts:fontWeight="bold">Gras</span></p>
<p begin="oops" end="1s">bad</p>
</div></body></tt>`;

test('TTML: language, styles by reference, br, nested begin, frames, dur, bad paragraph skipped', () => {
  const d = parseTtml(TTML);
  assert.equal(d.meta.language, 'fr');
  assert.equal(d.cues.length, 2);
  assert.equal(d.cues[0]!.id, 'p1');
  assert.deepEqual([d.cues[0]!.start, d.cues[0]!.end], [61_000, 63_000]);
  assert.equal(d.cues[0]!.text, 'Bonjour <font color="#ffff00"><i>le monde</i></font>\ndeuxieme &amp; ligne');
  assert.deepEqual([d.cues[1]!.start, d.cues[1]!.end], [65_480, 67_480]);
  assert.equal(d.cues[1]!.text, '<b>Gras</b>');
  assert.equal(d.cues[1]!.align, 3);
  assert.equal(d.warnings.length, 1);
});

test('TTML time expressions', () => {
  assert.equal(parseTtmlTime('00:00:01.500'), 1500);
  assert.equal(parseTtmlTime('00:00:01:15', 30), 1500);
  assert.equal(parseTtmlTime('1.5s'), 1500);
  assert.equal(parseTtmlTime('250ms'), 250);
  assert.equal(parseTtmlTime('2m'), 120_000);
  assert.equal(parseTtmlTime('30f', 25), 1200);
  assert.equal(parseTtmlTime('10000000t', 30, 10_000_000), 1000);
  assert.equal(parseTtmlTime('10000000t'), undefined);
  assert.equal(parseTtmlTime('soon'), undefined);
});

test('TTML: write and read back; refuses DTDs and other XML', () => {
  const d = parseSrt(SRT);
  const x = toTtml({ ...d, meta: { language: 'en' } });
  assert.match(x, /<span tts:fontStyle="italic">world<\/span>/);
  const back = parseTtml(x);
  assert.equal(back.meta.language, 'en');
  assert.deepEqual(back.cues.map((c) => [c.start, c.end, plainText(c)]), d.cues.map((c) => [c.start, c.end, plainText(c)]));
  assert.throws(() => parseTtml('<!DOCTYPE tt [<!ENTITY x "y">]><tt xmlns="http://www.w3.org/ns/ttml"/>'), SubtitleError);
  assert.throws(() => parseTtml('<html/>'), /not a TTML/);
  assert.throws(() => parseTtml('<tt'), SubtitleError);
});

test('detect and parse by sniffing; convert across all pairs keeps the words', () => {
  assert.equal(detect(SRT), 'srt');
  assert.equal(detect(VTT), 'vtt');
  assert.equal(detect(ASS), 'ass');
  assert.equal(detect(TTML), 'ttml');
  assert.equal(detect('hello'), undefined);
  assert.throws(() => parse('hello'), /not recognised/);
  const formats: Format[] = ['srt', 'vtt', 'ass', 'ttml'];
  const words = parse(SRT).cues.map((c) => plainText(c));
  for (const a of formats) {
    const text = convert(SRT, a);
    for (const b of formats) {
      const out = parse(convert(text, b, a));
      assert.deepEqual(out.cues.map((c) => plainText(c)), words, `${a} -> ${b}`);
      assert.deepEqual(out.cues.map((c) => c.start), [1000, 4500, 60_000], `${a} -> ${b} times`);
    }
  }
});

test('decodeBytes: BOMs, UTF-8, and Windows-1252 fallback', () => {
  assert.equal(decodeBytes(Buffer.from('﻿café', 'utf8')), 'café');
  assert.equal(decodeBytes(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hé', 'utf16le')])), 'hé');
  assert.equal(decodeBytes(Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('hé', 'utf16le').swap16()])), 'hé');
  assert.equal(decodeBytes(Buffer.from('café', 'utf8')), 'café');
  assert.equal(decodeBytes(Buffer.from([0x63, 0x61, 0x66, 0xe9])), 'café');
});

const base = (): Doc => parseSrt('1\n00:00:01,000 --> 00:00:02,000\nA\n\n2\n00:00:05,000 --> 00:00:06,000\nB\n\n3\n00:00:10,000 --> 00:00:12,000\nC\n');

test('shift: whole file, from a point, negative with clamping and dropping', () => {
  assert.deepEqual(shift(base(), 1500).cues.map((c) => c.start), [2500, 6500, 11_500]);
  assert.deepEqual(shift(base(), 1500, { from: 5000 }).cues.map((c) => c.start), [1000, 6500, 11_500]);
  const neg = shift(base(), -1500);
  assert.deepEqual(neg.cues.map((c) => [c.start, c.end]), [[0, 500], [3500, 4500], [8500, 10_500]]);
  assert.equal(shift(base(), -2500).cues.length, 2);
  assert.throws(() => shift(base(), Number.NaN), SubtitleError);
  assert.equal(base().cues[0]!.start, 1000);
});

test('stretch, frame-rate change and two-point sync', () => {
  assert.deepEqual(stretch(base(), 2).cues.map((c) => c.start), [2000, 10_000, 20_000]);
  const fr = changeFrameRate(base(), 23.976, 25);
  assert.equal(fr.cues[2]!.start, Math.round(10_000 * (23.976 / 25)));
  const sync = syncTwoPoints(base(), { from: 1000, to: 3000 }, { from: 10_000, to: 13_000 });
  assert.deepEqual(sync.cues.map((c) => c.start), [3000, 7444, 13_000]);
  assert.throws(() => syncTwoPoints(base(), { from: 1, to: 1 }, { from: 1, to: 2 }), SubtitleError);
  assert.throws(() => stretch(base(), 0), SubtitleError);
});

test('repair: sorts, lengthens short cues, trims overlaps, caps long ones', () => {
  const messy = parseSrt('1\n00:00:05,000 --> 00:00:05,100\nlate\n\n2\n00:00:01,000 --> 00:00:09,000\nlong overlaps\n\n3\n00:00:02,000 --> 00:00:30,000\nvery long\n');
  assert.equal(overlaps(messy).length, 3);
  const r = repair(messy, { minDurationMs: 500, maxDurationMs: 10_000, minGapMs: 50 });
  assert.deepEqual(r.cues.map((c) => plainText(c)), ['long overlaps', 'very long', 'late']);
  assert.deepEqual(r.cues.map((c) => [c.start, c.end]), [[1000, 1950], [2000, 4950], [5000, 5500]]);
  assert.deepEqual(overlaps(r), []);
  const lone = repair(parseSrt('1\n00:00:01,000 --> 00:00:30,000\nx\n'), { maxDurationMs: 4000 });
  assert.equal(lone.cues[0]!.end, 5000);
});

test('merge and activeAt', () => {
  const a = base();
  const b = parseSrt('1\n00:00:03,000 --> 00:00:04,000\nmid\n');
  const m = merge(a, b);
  assert.deepEqual(m.cues.map((c) => plainText(c)), ['A', 'mid', 'B', 'C']);
  assert.deepEqual(activeAt(m, 3500).map((c) => plainText(c)), ['mid']);
  assert.deepEqual(activeAt(m, 2000), []);
});

test('burn-in plan scales styles to the video and applies positions', () => {
  const d = parseAss(ASS);
  const plan = burnInPlan(d, { width: 1280, height: 720 });
  assert.equal(plan.events.length, 2);
  const e0 = plan.events[0]!;
  assert.equal(e0.style.fontSize, 56);
  assert.equal(e0.style.marginV, 40);
  assert.equal(e0.style.align, 2);
  assert.deepEqual(e0.runs.map((r) => [r.text, r.italic]), [['Hello, ', false], ['world', true], ['\nsecond line', false]]);
  const e1 = plan.events[1]!;
  assert.equal(e1.style.fontName, 'Impact');
  assert.equal(e1.style.align, 9);
  assert.deepEqual(e1.at, { x: 640, y: 72 });
  assert.equal(e1.runs[0]!.bold, true);
  assert.equal(e1.runs[0]!.colour, '#ff0000');
  assert.throws(() => burnInPlan(d, { width: 0, height: 1 }), SubtitleError);
  const missing = burnInPlan({ ...d, cues: [{ ...d.cues[0]!, style: 'Nope' }] }, { width: 640, height: 360 });
  assert.match(missing.warnings[0]!, /not defined/);
});

test('ffmpeg filter text is escaped on both levels', () => {
  assert.equal(ffmpegEscape('a:b'), 'a\\\\:b');
  assert.equal(ffmpegEscape("it's"), "it\\\\\\'s");
  const nasty = "/tmp/x'y:z[1],2;3\\4.srt";
  const f = subtitlesFilter(nasty, { style: { fontName: 'Open Sans', fontSize: 24, colour: '#ffffff', align: 2, bold: true } });
  assert.ok(f.startsWith('subtitles=filename='));
  const afterName = f.slice('subtitles=filename='.length, f.indexOf(':force_style='));
  assert.ok(!/(?<!\\)[\[\],;]/.test(afterName.replace(/\\\\/g, '')), afterName);
  assert.match(f, /force_style=FontName=Open Sans\\,FontSize=24\\,PrimaryColour=&H00FFFFFF\\,Bold=1\\,Alignment=2/);
  assert.throws(() => ffmpegEscape('a\nb'), SubtitleError);
  assert.equal(forceStyle({ fontName: 'A,B=C', outline: 2.4 }), 'FontName=A B C,Outline=2');
});

test('write() dispatches and files produced parse as the same cue count', () => {
  const d = parseAss(ASS);
  for (const f of ['srt', 'vtt', 'ass', 'ttml'] as const) assert.equal(parse(write(d, f), f).cues.length, 2, f);
});
