import assert from 'node:assert/strict';
import { test } from 'node:test';
import { block, encodeAttrs, LimitExceeded, MarkupError, normalise, parse, plainText, qualify, registry, serialize, short, validate, walkBlocks } from './index.ts';
import type { BlockType } from './index.ts';

const doc = `<!-- wp:heading {"level":3} -->
<h3>Title</h3>
<!-- /wp:heading -->

Some loose <b>HTML</b> between.

<!-- wp:group {"className":"box"} -->
<div class="box">
<!-- wp:paragraph -->
<p>One</p>
<!-- /wp:paragraph -->

<!-- wp:separator /-->

<!-- wp:acme/quote {"cite":"Ann"} -->
<blockquote>Q</blockquote>
<!-- /wp:acme/quote -->
</div>
<!-- /wp:group -->`;

test('a document parses into blocks, freeform HTML, and nested blocks, with attributes', () => {
  const { blocks, problems } = parse(doc);
  assert.deepEqual(problems, []);
  assert.deepEqual(blocks.map((b) => b.name), ['core/heading', null, 'core/group']);
  assert.deepEqual(blocks[0]!.attrs, { level: 3 });
  assert.equal(blocks[0]!.innerHTML, '\n<h3>Title</h3>\n');
  assert.match(blocks[1]!.innerHTML, /^\nSome loose <b>HTML<\/b> between\.\n$|^\s*Some loose/);
  const group = blocks[2]!;
  assert.deepEqual(group.innerBlocks.map((b) => b.name), ['core/paragraph', 'core/separator', 'acme/quote']);
  assert.deepEqual(group.innerBlocks[2]!.attrs, { cite: 'Ann' });
  assert.equal(group.innerContent.filter((c) => c === null).length, 3);
  assert.equal(group.innerContent.length, 7, 'chunks around every inner block');
  assert.equal(group.innerContent[0], '\n<div class="box">\n');
  assert.equal(group.innerContent.at(-1), '\n</div>\n');
  assert.equal(group.innerBlocks[1]!.innerContent.length, 0, 'a void block holds nothing');
});

test('serialising a parse writes the same document back, and a second round changes nothing', () => {
  const once = serialize(parse(doc).blocks);
  assert.equal(once, doc);
  assert.equal(serialize(parse(once).blocks), once);
  const odd = '<!--   wp:paragraph   {"a":1}   -->\n<p>x</p>\n<!--  /wp:paragraph  -->';
  const norm = serialize(parse(odd).blocks);
  assert.equal(norm, '<!-- wp:paragraph {"a":1} -->\n<p>x</p>\n<!-- /wp:paragraph -->', 'spacing in delimiters is normalised');
  assert.equal(serialize(parse(norm).blocks), norm);
});

test('names: core is implied, namespaces are kept, and bad names are not blocks', () => {
  assert.equal(qualify('paragraph'), 'core/paragraph');
  assert.equal(qualify('acme/card'), 'acme/card');
  assert.equal(short('core/paragraph'), 'paragraph');
  assert.equal(short('acme/card'), 'acme/card');
  const { blocks } = parse('<!-- wp:Bad /--><!-- wp:1x /--><!-- wp:a/b/c /--><!-- wpx:ok /--><!-- wp:good-name_2 /-->');
  assert.deepEqual(blocks.map((b) => b.name), [null, 'core/good-name_2']);
  assert.equal(blocks[0]!.innerHTML, '<!-- wp:Bad /--><!-- wp:1x /--><!-- wp:a/b/c /--><!-- wpx:ok /-->', 'look-alikes stay as HTML');
  assert.deepEqual(parse('<!-- x:para /-->', { prefix: 'x' }).blocks.map((b) => b.name), ['core/para'], 'another comment prefix');
  assert.throws(() => block('Bad Name'), MarkupError);
});

test('attribute JSON is escaped so it can never end the comment or open a tag', () => {
  const attrs = { text: 'a --> <script>alert("x")</script> & b -- c', nested: { list: ['<b>', '--'] } };
  const written = serialize([block('paragraph', attrs, [], { html: '<p>x</p>' })]);
  const comment = written.slice(0, written.indexOf('-->') + 3);
  assert.equal(comment.includes('<script'), false);
  assert.equal(comment.slice(4, -3).includes('--'), false, 'no double hyphen inside the comment');
  assert.match(encodeAttrs({ q: 'say "hi"' }), /\\u0022hi\\u0022/);
  assert.deepEqual(parse(written).blocks[0]!.attrs, attrs, 'and it reads back exactly');
  assert.equal(parse(written).blocks.length, 1);
});

test('bad attribute JSON is repaired and reported, or refused in strict mode', () => {
  const src = '<!-- wp:paragraph {"a":} -->\n<p>x</p>\n<!-- /wp:paragraph -->';
  const r = parse(src);
  assert.deepEqual(r.blocks[0]!.attrs, {});
  assert.deepEqual(r.problems.map((p) => p.code), ['bad-attributes']);
  assert.throws(() => parse(src, { strict: true }), MarkupError);
  assert.deepEqual(parse('<!-- wp:p {"a":[1,2]} /-->').blocks[0]!.attrs, { a: [1, 2] });
  assert.deepEqual(parse('<!-- wp:p [1,2] /-->').blocks.map((b) => b.name), [null], 'only a JSON object counts as attributes');
});

test('prototype tricks in attributes are dropped', () => {
  const b = parse('<!-- wp:p {"__proto__":{"admin":true},"constructor":1,"ok":{"__proto__":{"x":1},"y":2}} /-->').blocks[0]!;
  assert.deepEqual(b.attrs, { ok: { y: 2 } });
  assert.equal(({} as Record<string, unknown>)['admin'], undefined);
});

test('an unclosed block is closed at the end; a stray closer becomes text; crossed closers are repaired', () => {
  const un = parse('<!-- wp:group -->\n<div><!-- wp:paragraph -->\n<p>x</p>');
  assert.deepEqual(un.problems.map((p) => p.code), ['unclosed', 'unclosed']);
  assert.equal(un.blocks[0]!.innerBlocks[0]!.name, 'core/paragraph');
  const stray = parse('hello <!-- /wp:paragraph --> world');
  assert.deepEqual(stray.problems.map((p) => p.code), ['stray-closer']);
  assert.equal(stray.blocks.length, 1);
  assert.match(stray.blocks[0]!.innerHTML, /hello <!-- \/wp:paragraph --> world/);
  const crossed = parse('<!-- wp:group --><!-- wp:paragraph -->a<!-- /wp:group -->');
  assert.deepEqual(crossed.problems.map((p) => p.code), ['unclosed']);
  assert.equal(crossed.blocks.length, 1);
  assert.throws(() => parse('<!-- wp:a -->', { strict: true }), /never closed/);
  assert.throws(() => parse('<!-- /wp:a -->', { strict: true }), /nothing open/);
});

test('ordinary comments and look-alikes are left as HTML', () => {
  const r = parse('<!-- just a note --><!--wp:para--><!-- wp:para<p>x</p>');
  assert.deepEqual(r.blocks.map((b) => b.name), [null]);
  assert.equal(r.blocks[0]!.innerHTML, '<!-- just a note --><!--wp:para--><!-- wp:para<p>x</p>');
  assert.equal(serialize(r.blocks), r.blocks[0]!.innerHTML);
});

test('hostile input is bounded: size, depth, block count, attribute size, and slow shapes', () => {
  assert.throws(() => parse('x'.repeat(101), { maxLength: 100 }), LimitExceeded);
  assert.throws(() => parse('<!-- wp:g -->'.repeat(70)), /levels of nesting/);
  assert.throws(() => parse('<!-- wp:g /-->'.repeat(11), { maxBlocks: 10 }), /blocks/);
  assert.throws(() => parse(`<!-- wp:g {"a":"${'x'.repeat(70_000)}"} /-->`), /bytes of attributes/);
  const t0 = Date.now();
  parse('<!-- '.repeat(100_000));
  parse('<!-- wp:a {'.repeat(20_000));
  parse('<!-- wp:a '.repeat(50_000) + '-->');
  assert.ok(Date.now() - t0 < 3000, 'pathological documents finish quickly');
});

const types: BlockType[] = [
  { name: 'paragraph', attributes: { align: { type: 'string', enum: ['left', 'center', 'right'] }, dropCap: { type: 'boolean', default: false } } },
  { name: 'heading', attributes: { level: { type: 'integer', default: 2, enum: [1, 2, 3, 4, 5, 6] } } },
  { name: 'group', inner: true, allowedChildren: ['paragraph', 'heading', 'acme/card'] },
  { name: 'acme/card', allowedParents: ['group'], attributes: { title: { type: 'string', required: true } }, aliases: ['acme/old-card'] },
  { name: 'columns', inner: true, allowedChildren: ['column'] },
  { name: 'column', inner: true, allowedParents: ['columns'] },
  { name: 'html', checkHTML: (h) => (h.includes('TODO') ? 'unfinished' : null) },
];
const reg = registry(types);
const codes = (src: string) => validate(parse(src).blocks, reg).map((p) => `${p.path}:${p.code}`);

test('validation checks attribute types, enums, required attributes and unknown attributes', () => {
  assert.deepEqual(codes('<!-- wp:paragraph {"align":"left"} --><p>x</p><!-- /wp:paragraph -->'), []);
  assert.deepEqual(codes('<!-- wp:paragraph {"align":"justify"} --><p>x</p><!-- /wp:paragraph -->'), ['0:attribute-value']);
  assert.deepEqual(codes('<!-- wp:paragraph {"dropCap":"yes"} --><p>x</p><!-- /wp:paragraph -->'), ['0:attribute-type']);
  assert.deepEqual(codes('<!-- wp:paragraph {"color":"red"} --><p>x</p><!-- /wp:paragraph -->'), ['0:attribute-unknown']);
  assert.deepEqual(validate(parse('<!-- wp:paragraph {"color":"red"} --><p>x</p><!-- /wp:paragraph -->').blocks, reg, { strictAttributes: false }), []);
  assert.deepEqual(codes('<!-- wp:heading {"level":2.5} /-->'), ['0:attribute-type']);
  assert.deepEqual(codes('<!-- wp:heading {"level":7} /-->'), ['0:attribute-value']);
  assert.deepEqual(codes('<!-- wp:group --><!-- wp:acme/card {} /--><!-- /wp:group -->'), ['0.0:attribute-missing']);
  assert.match(validate(parse('<!-- wp:heading {"level":9} /-->').blocks, reg)[0]!.message, /"level" of core\/heading must be one of 1, 2, 3, 4, 5, 6/);
});

test('validation checks where blocks may sit and what may hold blocks', () => {
  assert.deepEqual(codes('<!-- wp:group --><!-- wp:heading /--><!-- /wp:group -->'), []);
  assert.deepEqual(codes('<!-- wp:group --><!-- wp:html --><p>x</p><!-- /wp:html --><!-- /wp:group -->'), ['0.0:child-not-allowed']);
  assert.deepEqual(codes('<!-- wp:acme/card {"title":"t"} /-->'), ['0:parent-not-allowed']);
  assert.deepEqual(codes('<!-- wp:paragraph --><!-- wp:heading /--><!-- /wp:paragraph -->'), ['0:inner-not-allowed']);
  assert.deepEqual(codes('<!-- wp:columns --><!-- wp:column --><!-- wp:paragraph /--><!-- /wp:column --><!-- /wp:columns -->'), []);
  assert.deepEqual(codes('<!-- wp:column /-->'), ['0:parent-not-allowed']);
  assert.deepEqual(codes('<!-- wp:nothing /-->'), ['0:unregistered']);
});

test('validation reads the HTML inside blocks: unbalanced tags, forbidden tags, custom checks', () => {
  assert.deepEqual(codes('<!-- wp:paragraph --><p>a <b>b</p><!-- /wp:paragraph -->'), ['0:html-unbalanced']);
  assert.deepEqual(codes('<!-- wp:paragraph --><p>a</b></p><!-- /wp:paragraph -->'), ['0:html-unbalanced']);
  assert.deepEqual(codes('<!-- wp:paragraph --><p>a<br>b<img src="x"></p><!-- /wp:paragraph -->'), [], 'void elements need no closer');
  assert.deepEqual(codes('<!-- wp:paragraph --><p>x</p><script>alert(1)</script><!-- /wp:paragraph -->'), ['0:forbidden-tag']);
  assert.deepEqual(codes('<!-- wp:paragraph --><iframe src="https://x.test"></iframe><!-- /wp:paragraph -->'), ['0:forbidden-tag']);
  assert.deepEqual(codes('<!-- wp:html --><p>TODO</p><!-- /wp:html -->'), ['0:html-invalid']);
  assert.deepEqual(codes('<script>x</script>'), ['0:forbidden-tag'], 'also in freeform HTML');
  assert.deepEqual(validate(parse('<!-- wp:paragraph --><iframe></iframe><!-- /wp:paragraph -->').blocks, reg, { forbidTags: [] }), []);
});

test('normalising fills defaults, renames old names, and wraps what is invalid in a fallback that writes back unchanged', () => {
  const src = '<!-- wp:heading /-->\n\n<!-- wp:acme/old-card {"title":"T"} -->\n<p>c</p>\n<!-- /wp:acme/old-card -->\n\n<!-- wp:mystery {"a":1} -->\n<p>who knows</p>\n<!-- /wp:mystery -->\n\n<!-- wp:paragraph {"align":"justify"} -->\n<p>bad</p>\n<!-- /wp:paragraph -->';
  const { blocks, problems } = normalise(parse(src).blocks, reg);
  assert.deepEqual(blocks.map((b) => b.name), ['core/heading', 'core/missing', 'core/missing', 'core/missing']);
  assert.deepEqual(blocks[0]!.attrs, { level: 2 }, 'default filled');
  assert.deepEqual(problems.map((p) => `${p.path}:${p.code}`), ['1:parent-not-allowed', '2:unregistered', '3:attribute-value']);
  assert.equal(blocks[2]!.attrs['originalName'], 'core/mystery');
  assert.equal(serialize(blocks.slice(2)), '<!-- wp:mystery {"a":1} -->\n<p>who knows</p>\n<!-- /wp:mystery -->\n\n<!-- wp:paragraph {"align":"justify"} -->\n<p>bad</p>\n<!-- /wp:paragraph -->', 'the fallback writes the original markup back byte for byte');
  const alias = normalise(parse('<!-- wp:group --><!-- wp:acme/old-card {"title":"T"} /--><!-- /wp:group -->').blocks, reg);
  assert.equal(alias.blocks[0]!.innerBlocks[0]!.name, 'acme/card', 'an old name is read as the current type');
  assert.throws(() => registry([{ name: 'a' }, { name: 'core/a' }]), /registered twice/);
});

test('blocks built in code serialise like parsed ones, and nested builders keep their structure', () => {
  const doc2 = [
    block('heading', { level: 2 }, [], { html: '<h2>Hi</h2>' }),
    block('group', { className: 'box' }, [block('paragraph', {}, [], { html: '<p>a</p>' }), block('separator')], { before: '<div class="box">', after: '</div>' }),
  ];
  const out = serialize(doc2);
  assert.equal(out, '<!-- wp:heading {"level":2} -->\n<h2>Hi</h2>\n<!-- /wp:heading -->\n\n<!-- wp:group {"className":"box"} -->\n<div class="box">\n<!-- wp:paragraph -->\n<p>a</p>\n<!-- /wp:paragraph -->\n\n<!-- wp:separator /-->\n</div>\n<!-- /wp:group -->');
  assert.equal(serialize(parse(out).blocks), out);
  const bare = { name: 'core/group', attrs: {}, innerBlocks: [block('separator')], innerHTML: '', innerContent: [] };
  assert.equal(serialize([bare]), '<!-- wp:group -->\n<!-- wp:separator /-->\n<!-- /wp:group -->', 'inner blocks with no content slots still write');
});

test('plain text and walking read the whole tree in order', () => {
  const { blocks } = parse(doc);
  assert.equal(plainText(blocks[2]!), 'One Q');
  assert.deepEqual([...walkBlocks(blocks)].map((w) => `${w.path}=${w.block.name}`), ['0=core/heading', '1=null', '2=core/group', '2.0=core/paragraph', '2.1=core/separator', '2.2=acme/quote']);
  assert.equal(plainText(blocks[0]!), 'Title');
});
