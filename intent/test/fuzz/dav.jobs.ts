/** Bounded (worker) jobs for dav.test.ts: the safe XML reader must answer or refuse, and finish. */
import { BadXml, parseXml, type El } from '../../blocks/dav/index.ts';
import { runCases, type Rand } from './harness.ts';

const NAMES = ['a', 'b', 'D:prop', 'D:href', 'x:y', 'propfind', 'd:multistatus', 'é', 'a.b-c_d', '__proto__', 'constructor'];
const ATTRS = [' xmlns="DAV:"', ' xmlns:D="DAV:"', ' xmlns:x="urn:x"', ' xmlns:d="DAV:"', ' a="1"', " b='2'", ' c="&amp;&lt;"', ' D:z="q"', ' xml:lang="en"', ' e="&#233;"', ' f="&nope;"', ' g="<"', ' h=">"', ' i="a\'b"', ' j', ' ="x"', ' k = "s p"'];
const TEXT = ['text', ' ', '\n', '&amp;', '&lt;', '&gt;', '&quot;', '&apos;', '&#65;', '&#x1F600;', '&#1114112;', '&#xFFFFFFFF;', '&nope;', '&', ';', '&amp', ']]>', 'é', '😀', '>'];
const MISC = ['<!-- c -->', '<!--', '-->', '<?xml version="1.0"?>', '<?pi x?>', '<?', '<![CDATA[<raw>&amp;]]>', '<![CDATA[', '<!DOCTYPE a [<!ENTITY x "y">]>', '<!doctype a>', '<!ENTITY x SYSTEM "file:///etc/passwd">', '<!ELEMENT a ANY>', '<!x>', '<', '</', '/>', '>'];

/** XML-shaped soup: mostly balanced elements with random attributes, text, comments and damage. */
export const soup = (r: Rand, depth = 0): string => {
  const parts: string[] = [];
  for (let k = r.int(0, depth === 0 ? 1 : 4); k >= 0; k--) {
    const x = r.int(0, 9);
    if (x < 5 && depth < 8) {
      const name = r.pick(NAMES);
      const attrs = r.array(0, 3, () => r.pick(ATTRS)).join('');
      if (r.bool(0.3)) parts.push(`<${name}${attrs}/>`);
      else parts.push(`<${name}${attrs}>${soup(r, depth + 1)}</${r.bool(0.95) ? name : r.pick(NAMES)}>`);
    } else if (x < 8) parts.push(r.array(1, 3, () => r.pick(TEXT)).join(''));
    else parts.push(r.pick(MISC));
  }
  return parts.join('');
};

export const xmlish = (r: Rand): string => {
  const k = r.int(0, 9);
  if (k === 0) return r.text(0, 80);
  if (k === 1) return r.str(0, 60, ['<', '>', '/', '!', '?', '-', '[', ']', '&', ';', '"', "'", '=', 'a', ':', ' ']);
  const s = soup(r);
  if (k === 2 && s.length) {
    const at = r.int(0, s.length);
    return s.slice(0, at) + r.pick(MISC) + s.slice(at);
  }
  return s;
};

/** Every node has string ns and name, string attribute values, and the tree is no deeper than the limit. */
export function checkTree(el: El, maxDepth: number, depth = 1): void {
  if (depth > maxDepth) throw new Error(`depth ${depth} past maxDepth ${maxDepth}`);
  if (typeof el.ns !== 'string') throw new Error(`ns of <${String(el.name)}> is ${typeof el.ns}, not a string`);
  if (typeof el.name !== 'string' || !el.name) throw new Error('an element without a string name');
  if (typeof el.text !== 'string') throw new Error('text is not a string');
  for (const [k, v] of Object.entries(el.attrs)) if (typeof v !== 'string') throw new Error(`attribute ${k} is ${typeof v}`);
  for (const c of el.children) checkTree(c, maxDepth, depth + 1);
}

const polluted = () => ({} as Record<string, unknown>).polluted !== undefined;

/** Random and damaged XML: an El tree that passes checkTree, or BadXml; never another error. */
export function randomXml(seed: number, cases: number, only: number | undefined, report: (i: number, input: unknown) => void): void {
  runCases('parseXml on random XML returns a sound tree or BadXml', seed, cases, only, report, (r) => ({ src: xmlish(r), maxDepth: r.pick([64, 64, 3, 1]) }), ({ src, maxDepth }) => {
    let el: El;
    try {
      el = parseXml(src, { maxDepth });
    } catch (e) {
      if (!(e instanceof BadXml)) throw new Error(`threw ${e instanceof Error ? `${e.constructor.name}: ${e.message}` : String(e)} instead of BadXml`);
      return;
    }
    if (/<!DOCTYPE|<!ENTITY/i.test(src)) throw new Error('accepted a document type declaration');
    checkTree(el, maxDepth);
    if (polluted()) throw new Error('Object.prototype was polluted');
  });
}

/** The same, but element prefixes named after Object.prototype members must be refused or resolve to strings. */
export function prototypePrefixes(seed: number, cases: number, only: number | undefined, report: (i: number, input: unknown) => void): void {
  runCases('parseXml prefixes named like Object.prototype members', seed, cases, only, report, (r) => {
    const p = r.pick(['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf', 'isPrototypeOf']);
    const declare = r.bool(0.5) ? ` xmlns:${p}="urn:x"` : '';
    return r.pick([`<${p}:a${declare}/>`, `<a${declare}><${p}:b/></a>`, `<a${declare} ${p}:attr="v"/>`]);
  }, (src) => {
    let el: El;
    try {
      el = parseXml(src);
    } catch (e) {
      if (!(e instanceof BadXml)) throw new Error(`threw ${e instanceof Error ? e.constructor.name : typeof e} instead of BadXml`);
      return;
    }
    checkTree(el, 64);
    for (const k of Object.keys(el.attrs)) if (!/^(\{[^}]*\})?[^{}]+$/.test(k) || /\{function|\{\[object/.test(k)) throw new Error(`attribute key ${k}`);
  });
}

/** One start tag with a huge attribute-ish run (no '='), a few tens of kB: must be read or refused quickly. */
export function hugeAttribute(seed: number, cases: number, only: number | undefined, report: (i: number, input: unknown) => void): void {
  runCases('parseXml on a huge attribute finishes in linear time', seed, cases, only, report, (r) => ({ n: r.int(30_000, 60_000), ch: r.pick(['x', 'a:b', '-']) }), ({ n, ch }) => {
    const t = performance.now();
    try {
      parseXml(`<a ${ch.repeat(Math.ceil(n / ch.length))}/>`);
    } catch (e) {
      if (!(e instanceof BadXml)) throw e;
    }
    const took = performance.now() - t;
    if (took > 250) throw new Error(`${n} characters took ${took.toFixed(0)} ms`);
  });
}

/** Many namespace declarations on the root and many children: each child must not copy the whole scope. */
export function manyNamespaces(seed: number, cases: number, only: number | undefined, report: (i: number, input: unknown) => void): void {
  runCases('parseXml with many namespace declarations finishes in linear time', seed, cases, only, report, (r) => ({ k: r.int(3000, 5000) }), ({ k }) => {
    const decl = Array.from({ length: k }, (_, i) => ` xmlns:p${i}="u"`).join('');
    const src = `<r${decl}>${'<a/>'.repeat(k)}</r>`;
    const t = performance.now();
    try {
      parseXml(src);
    } catch (e) {
      if (!(e instanceof BadXml)) throw e;
    }
    const took = performance.now() - t;
    if (took > 250) throw new Error(`${src.length} characters took ${took.toFixed(0)} ms`);
  });
}
