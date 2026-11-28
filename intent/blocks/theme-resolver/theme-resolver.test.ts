import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BadAssetPath, Resolver, TemplateLimitError, TemplateNotFound, TemplateSyntaxError, ThemeChainError, ThemeError,
  escapeHtml, hierarchy, mergeSettings, slugPart, type Theme,
} from './index.ts';

const parent: Theme = {
  id: 'parent',
  files: { 'index.html': 'P-index', 'single.html': 'P-single', 'page.html': 'P-page', 'parts/header.html': '<h1>{{ site }}</h1>', 'parts/footer.html': 'P-footer', 'layout.html': '[{% block body %}default{% endblock %}]' },
  assets: { 'css/site.css': 'body{}', 'js/app.js': 'alert(1)' },
  themeJson: { settings: { color: { palette: ['red'], link: 'blue' }, layout: { wide: '1200px' } } },
};
const child: Theme = {
  id: 'child',
  parent: 'parent',
  files: { 'single.html': 'C-single', 'parts/footer.html': 'C-footer', 'page.html': '{% extends "layout" %}{% block body %}C-page {{ title }}{% endblock %}' },
  assets: { 'css/site.css': 'body{color:red}' },
  themeJson: { settings: { color: { palette: ['green', 'pink'] }, layout: { narrow: '600px' } } },
};
const R = () => new Resolver([parent, child], 'child');

test('hierarchy for posts, pages, terms, authors, search, 404 and attachments', () => {
  assert.deepEqual(hierarchy({ kind: 'single', postType: 'post', slug: 'Hello World!' }), ['single-post-hello-world', 'single-post', 'single', 'singular', 'index']);
  assert.deepEqual(hierarchy({ kind: 'single', postType: 'product', slug: 'mug' }), ['single-product-mug', 'single-product', 'single', 'singular', 'index']);
  assert.deepEqual(hierarchy({ kind: 'page', slug: 'about', id: 7, template: 'wide.php' }), ['wide', 'page-about', 'page-7', 'page', 'singular', 'index']);
  assert.deepEqual(hierarchy({ kind: 'taxonomy', taxonomy: 'category', term: 'news', id: 3 }), ['category-news', 'category-3', 'category', 'archive', 'index']);
  assert.deepEqual(hierarchy({ kind: 'taxonomy', taxonomy: 'genre', term: 'jazz' }), ['taxonomy-genre-jazz', 'taxonomy-genre', 'taxonomy', 'archive', 'index']);
  assert.deepEqual(hierarchy({ kind: 'author', nicename: 'ann', id: 2 }), ['author-ann', 'author-2', 'author', 'archive', 'index']);
  assert.deepEqual(hierarchy({ kind: 'search' }), ['search', 'index']);
  assert.deepEqual(hierarchy({ kind: 'notFound' }), ['404', 'index']);
  assert.deepEqual(hierarchy({ kind: 'attachment', mime: 'image/png' }), ['image', 'png', 'image-png', 'attachment', 'single', 'singular', 'index']);
  assert.deepEqual(hierarchy({ kind: 'front' }), ['front-page', 'home', 'index']);
  assert.deepEqual(hierarchy({ kind: 'front', staticPage: { slug: 'start' } }), ['front-page', 'page-start', 'page', 'singular', 'index']);
});

test('slugs cannot carry a path out of the theme', () => {
  assert.equal(slugPart('../../etc/passwd'), 'etc-passwd');
  assert.equal(slugPart('a/b\\c'), 'a-b-c');
  assert.equal(slugPart('  '), '');
  assert.deepEqual(hierarchy({ kind: 'single', postType: 'post', slug: '../../x' }).slice(0, 2), ['single-post-x', 'single-post']);
  assert.ok(hierarchy({ kind: 'page', slug: '!!!' }).every((n) => /^[a-z0-9_-]+$/.test(n)));
});

test('the child wins, and the parent fills in what the child lacks', () => {
  const r = R();
  assert.equal(r.resolve({ kind: 'single', postType: 'post' }).theme, 'child');
  assert.equal(r.resolve({ kind: 'single', postType: 'post' }).source, 'C-single');
  assert.equal(r.resolve({ kind: 'search' }).theme, 'parent');
  assert.equal(r.resolve({ kind: 'search' }).name, 'index');
});

test('a more specific name beats a closer theme', () => {
  const t: Theme = { id: 'p', files: { 'single-post-hi.html': 'specific' } };
  const c: Theme = { id: 'c', parent: 'p', files: { 'single.html': 'generic child' } };
  const f = new Resolver([t, c], 'c').resolve({ kind: 'single', postType: 'post', slug: 'hi' });
  assert.equal(f.source, 'specific');
  assert.equal(f.theme, 'p');
});

test('site edits sit above every theme and can be removed again', () => {
  const r = R();
  r.setCustom('single', 'custom!');
  const f = r.resolve({ kind: 'single', postType: 'post' });
  assert.equal(f.theme, '(site)');
  assert.equal(f.source, 'custom!');
  r.setCustom('single', undefined);
  assert.equal(r.resolve({ kind: 'single', postType: 'post' }).source, 'C-single');
  assert.throws(() => r.setCustom('!!!', 'x'), ThemeError);
});

test('block themes look in templates/ and parts/', () => {
  const b: Theme = { id: 'blk', kind: 'block', files: { 'templates/index.html': 'B-index', 'templates/single.html': 'B-single' } };
  const r = new Resolver([b], 'blk');
  assert.equal(r.resolve({ kind: 'single', postType: 'post' }).path, 'templates/single.html');
  assert.equal(r.resolve({ kind: 'search' }).path, 'templates/index.html');
});

test('a missing template lists what was tried', () => {
  const r = new Resolver([{ id: 'empty' }], 'empty');
  assert.throws(() => r.resolve({ kind: 'search' }), (e: unknown) => e instanceof TemplateNotFound && e.tried.includes('empty:search.html') && e.tried.includes('empty:index.html'));
});

test('chain problems: missing, looping, too deep, bad or duplicate ids', () => {
  assert.throws(() => new Resolver([parent], 'nope'), ThemeChainError);
  assert.throws(() => new Resolver([{ id: 'a', parent: 'ghost' }], 'a'), (e: unknown) => e instanceof ThemeChainError && /ghost/.test(e.message));
  assert.throws(() => new Resolver([{ id: 'a', parent: 'b' }, { id: 'b', parent: 'a' }], 'a'), /loop/);
  const many: Theme[] = Array.from({ length: 8 }, (_, i) => ({ id: `t${i}`, ...(i < 7 ? { parent: `t${i + 1}` } : {}) }));
  assert.throws(() => new Resolver(many, 't0'), /five deep/);
  assert.throws(() => new Resolver([{ id: '../x' }], '../x'), ThemeError);
  assert.throws(() => new Resolver([{ id: 'a' }, { id: 'a' }], 'a'), /twice/);
});

test('theme.json merges parent under child; arrays replace; poisoned keys are dropped', () => {
  const r = R();
  assert.deepEqual(r.setting('settings.color.palette'), ['green', 'pink']);
  assert.equal(r.setting('settings.color.link'), 'blue');
  assert.equal(r.setting('settings.layout.wide'), '1200px');
  assert.equal(r.setting('settings.layout.narrow'), '600px');
  assert.equal(r.setting('settings.nothing.here', 'dflt'), 'dflt');
  assert.equal(r.setting('settings.__proto__', 'safe'), 'safe');
  const evil = JSON.parse('{"__proto__":{"polluted":true},"a":{"constructor":{"x":1},"ok":1}}');
  const m = mergeSettings({}, evil) as Record<string, unknown>;
  assert.equal(({} as Record<string, unknown>)['polluted'], undefined);
  assert.deepEqual(m, { a: { ok: 1 } });
});

test('assets resolve child-first and carry a content hash in the URL', () => {
  const r = R();
  const a = r.asset('css/site.css');
  assert.equal(a.theme, 'child');
  assert.match(a.url, /^\/themes\/child\/css\/site\.css\?ver=[0-9a-f]{8}$/);
  assert.equal(a.hash.slice(0, 8), a.url.slice(-8));
  assert.match(a.integrity, /^sha384-[A-Za-z0-9+/]{64}$/);
  assert.equal(r.asset('js/app.js').theme, 'parent');
  assert.equal(a.bytes, 15);
  assert.throws(() => r.asset('css/none.css'), TemplateNotFound);
});

test('the asset hash is the SHA-256 of the file and changes only when the file does', () => {
  // SHA-256 of "abc" (FIPS 180-2 vector)
  const one = new Resolver([{ id: 't', assets: { 'a.txt': 'abc' } }], 't').asset('a.txt');
  assert.equal(one.hash, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  const two = new Resolver([{ id: 't', assets: { 'a.txt': new TextEncoder().encode('abc') } }], 't').asset('a.txt');
  assert.equal(two.hash, one.hash);
  assert.notEqual(new Resolver([{ id: 't', assets: { 'a.txt': 'abd' } }], 't').asset('a.txt').hash, one.hash);
});

test('the combined version changes when any served asset changes', () => {
  const v1 = R().version();
  assert.equal(R().version(), v1);
  const c2: Theme = { ...child, assets: { 'css/site.css': 'body{color:blue}' } };
  assert.notEqual(new Resolver([parent, c2], 'child').version(), v1);
  assert.deepEqual(R().assets().map((a) => `${a.path}@${a.theme}`), ['css/site.css@child', 'js/app.js@parent']);
});

test('asset paths that climb, hide or break are refused', () => {
  const r = R();
  for (const p of ['../secret', 'css/../../x', '/etc/passwd', 'a\\b', '', 'a//b', '.env', 'css/.hidden', 'a\u0000b', './a']) {
    assert.throws(() => r.asset(p), BadAssetPath, JSON.stringify(p));
  }
});

test('rendering escapes by default and raw is explicit', () => {
  const r = R();
  assert.equal(r.renderSource('{{ a }}|{{{ a }}}', { a: '<b>"x"&' }), '&lt;b&gt;&quot;x&quot;&amp;|<b>"x"&');
  assert.equal(r.renderSource('{{ n }} {{ t }} {{ o }} {{ u }}', { n: 5, t: true, o: { x: 1 }, u: null }), '5 true  ');
  assert.equal(escapeHtml(`'`), '&#39;');
});

test('parts resolve through the chain, and child parts win', () => {
  const r = R();
  assert.equal(r.renderSource('{% include "header" %}/{% include "footer" %}', { site: 'S&Co' }), '<h1>S&amp;Co</h1>/C-footer');
  assert.throws(() => r.renderSource('{% include "missing" %}', {}), TemplateNotFound);
});

test('extends and blocks: the child fills the parent layout', () => {
  const out = R().render({ kind: 'page', slug: 'x' }, { title: 'Hi <you>' });
  assert.equal(out.found.theme, 'child');
  assert.equal(out.html, '[C-page Hi &lt;you&gt;]');
  assert.equal(R().renderSource('{% extends "layout" %}', {}), '[default]');
});

test('if, else and for work, with scope and indexes', () => {
  const r = R();
  const t = '{% if items %}{% for i in items %}<{{ i.n }}/{{ site }}>{% endfor %}{% else %}none{% endif %}';
  assert.equal(r.renderSource(t, { site: 's', items: [{ n: 1 }, { n: 2 }] }), '<1/s><2/s>');
  assert.equal(r.renderSource(t, { items: [] }), 'none');
  assert.equal(r.renderSource('{{ l.1 }}', { l: ['a', 'b'] }), 'b');
  assert.equal(r.renderSource('{# gone #}x', {}), 'x');
});

test('lookups never reach the prototype or call anything', () => {
  const r = R();
  assert.equal(r.renderSource('{{ a.constructor }}{{ a.toString }}{{ a.length }}', { a: 'str' }), '');
  assert.equal(r.renderSource('{{ x.__proto__ }}', { x: {} }), '');
  assert.throws(() => r.renderSource('{{ a.b() }}', {}), TemplateSyntaxError);
  assert.throws(() => r.renderSource('{{ 1 + 1 }}', {}), TemplateSyntaxError);
  assert.throws(() => r.renderSource('{{ a["b"] }}', {}), TemplateSyntaxError);
});

test('syntax errors name the line', () => {
  const r = R();
  assert.throws(() => r.renderSource('ok\n{% if a %}never closed', {}), /never closed/);
  assert.throws(() => r.renderSource('a\nb\n{% endif %}', {}), /line 3/);
  assert.throws(() => r.renderSource('{% frobnicate %}', {}), /unknown tag/);
  assert.throws(() => r.renderSource('{% if a %}{% endfor %}', {}), TemplateSyntaxError);
  assert.throws(() => r.renderSource('{% else %}', {}), /else without if/);
});

test('loops of includes and extends are stopped, as are huge loops, outputs and templates', () => {
  const t: Theme = { id: 't', files: { 'parts/a.html': '{% include "b" %}', 'parts/b.html': '{% include "a" %}', 'x.html': '{% extends "y" %}', 'y.html': '{% extends "x" %}', 'index.html': 'i' } };
  const r = new Resolver([t], 't', { maxLoopIterations: 50, maxOutputBytes: 100, maxTemplateBytes: 300 });
  assert.throws(() => r.renderSource('{% include "a" %}', {}), /loop/);
  assert.throws(() => r.render(['x'], {}), TemplateLimitError);
  assert.throws(() => r.renderSource('{% for i in l %}x{% endfor %}', { l: new Array(100).fill(1) }), /too many times/);
  assert.throws(() => r.renderSource('{% for i in l %}0123456789{% endfor %}', { l: new Array(20).fill(1) }), /output is too large/);
  assert.throws(() => r.renderSource('x'.repeat(400), {}), TemplateLimitError);
  assert.throws(() => r.renderSource('{% if a %}'.repeat(40) + '{% endif %}'.repeat(40), {}), TemplateLimitError);
});
