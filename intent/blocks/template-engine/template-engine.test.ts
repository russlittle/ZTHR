import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Engine, FilterError, LimitExceeded, SafeString, TemplateSyntaxError, UndefinedVariable, render, strftime } from './index.ts';

const NOW = () => new Date('2026-03-05T14:07:09Z');

test('output tags are HTML-escaped by default; safe lets markup through', () => {
  const d = { name: `<b>"Tom" & 'Jerry'</b>`, html: '<i>ok</i>' };
  assert.equal(render('{{ name }}', d), '&lt;b&gt;&quot;Tom&quot; &amp; &#39;Jerry&#39;&lt;/b&gt;');
  assert.equal(render('{{ html | safe }}', d), '<i>ok</i>');
  assert.equal(render('{{ html | escape }}', d), '&lt;i&gt;ok&lt;/i&gt;', 'escape is not applied twice');
  assert.equal(render('{{ html | upcase }}', d), '&lt;I&gt;OK&lt;/I&gt;');
  assert.equal(render('{{ html | safe | upcase }}', d), '&lt;I&gt;OK&lt;/I&gt;', 'a filter that rebuilds the text loses the safe mark');
  assert.equal(render('{{ x }}', { x: new SafeString('<u>') }), '<u>');
});

test('paths read nested data, arrays, negative indexes and bracket keys', () => {
  const d = { user: { name: 'Ana', tags: ['a', 'b', 'c'], 'full name': 'Ana L' }, key: 'name' };
  assert.equal(render('{{ user.name }}|{{ user.tags[1] }}|{{ user.tags[-1] }}|{{ user.tags.size }}|{{ user.tags.first }}|{{ user.tags.last }}', d), 'Ana|b|c|3|a|c');
  assert.equal(render('{{ user["full name"] }}|{{ user[key] }}|{{ user.missing }}|{{ nothing.at.all }}', d), 'Ana L|Ana||');
  assert.equal(render('{{ "hello" | size }} {{ user.name.size }}', d), '5 3');
});

test('the program is out of reach: prototypes, constructors, methods and functions read as empty', () => {
  const data = { s: 'text', fn: () => 'x', o: { own: 1 }, inherited: Object.create({ secret: 'hidden' }) };
  assert.equal(render('{{ s.length }}|{{ s.constructor }}|{{ o.__proto__ }}|{{ o.constructor.name }}|{{ o.toString }}|{{ fn }}|{{ inherited.secret }}|{{ __proto__ }}|{{ constructor }}', data), '||||||||');
  assert.equal(render('{{ o["__proto__"] }}{{ o["constructor"] }}{{ o.hasOwnProperty }}', data), '');
  assert.equal(render('{{ own }}', Object.create({ own: 'inherited' })), '', 'top-level data is read as own properties only');
  assert.equal(render('{{ o.own }}', data), '1');
});

test('if, elsif, else and unless follow the rule that only false and nil are false', () => {
  const t = '{% if n > 10 %}big{% elsif n > 5 %}mid{% elsif n == 5 %}five{% else %}small{% endif %}';
  assert.deepEqual([11, 7, 5, 1].map((n) => render(t, { n })), ['big', 'mid', 'five', 'small']);
  assert.equal(render('{% unless ok %}no{% else %}yes{% endunless %}', { ok: false }), 'no');
  assert.deepEqual(['', 0, [], null, false].map((v) => render('{% if v %}T{% else %}F{% endif %}', { v })), ['T', 'T', 'T', 'F', 'F']);
  assert.equal(render('{% if a and b or c %}y{% else %}n{% endif %}', { a: true, b: false, c: true }), 'y');
  assert.equal(render('{% if tags contains "x" and name contains "na" %}y{% endif %}', { tags: ['x'], name: 'ana' }), 'y');
  assert.equal(render('{% if a != "q" %}y{% endif %}{% if 3 <= 3 %}z{% endif %}{% if "a" < "b" %}w{% endif %}', { a: 'p' }), 'yzw');
  assert.equal(render('{% if 1 < "a" %}y{% else %}n{% endif %}', {}), 'n', 'mixed types never compare true');
});

test('for loops: forloop values, limit, offset, reversed, ranges, else, break and continue', () => {
  const d = { xs: ['a', 'b', 'c', 'd'] };
  assert.equal(render('{% for x in xs %}{{ forloop.index }}{{ x }}{% if forloop.last %}.{% else %},{% endif %}{% endfor %}', d), '1a,2b,3c,4d.');
  assert.equal(render('{% for x in xs limit:2 offset:1 %}{{ x }}{% endfor %}', d), 'bc');
  assert.equal(render('{% for x in xs reversed %}{{ x }}{% endfor %}', d), 'dcba');
  assert.equal(render('{% for i in (2..5) %}{{ i }}{% endfor %}', {}), '2345');
  assert.equal(render('{% for i in (1..n) %}{{ i }}{% endfor %}', { n: 3 }), '123');
  assert.equal(render('{% for x in none %}x{% else %}empty{% endfor %}', {}), 'empty');
  assert.equal(render('{% for x in xs %}{% if x == "b" %}{% continue %}{% endif %}{% if x == "d" %}{% break %}{% endif %}{{ x }}{% endfor %}', d), 'ac');
  assert.equal(render('before{% for x in xs %}{{ x }}{% if x == "b" %}{% break %}{% endif %}{% endfor %}after', d), 'beforeabafter', 'output before a break is kept');
  assert.equal(render('{% for r in rows %}{% for c in r %}{{ c }}{% endfor %}|{% endfor %}', { rows: [[1, 2], [3]] }), '12|3|');
});

test('assign, capture and case', () => {
  assert.equal(render('{% assign n = price | times: 2 | plus: 1 %}{{ n }}', { price: 10 }), '21');
  assert.equal(render('{% capture g %}Hi {{ name }}{% endcapture %}[{{ g }}]', { name: '<A>' }), '[Hi &lt;A&gt;]', 'captured text is escaped once, not twice');
  const c = '{% case k %}{% when "a", "b" %}AB{% when 1 %}one{% else %}other{% endcase %}';
  assert.deepEqual(['a', 'b', 1, 'z'].map((k) => render(c, { k })), ['AB', 'AB', 'one', 'other']);
});

test('filters: text, list, math and default', () => {
  const r = (t: string, d: unknown = {}) => render(t, d, { now: NOW });
  assert.equal(r('{{ "  Hi  " | strip | upcase }}|{{ "hELLO" | capitalize }}|{{ "a-b" | replace: "-", "+" }}|{{ "x" | append: "y" | prepend: "w" }}|{{ "abc" | remove: "b" }}'), 'HI|Hello|a+b|wxy|ac');
  assert.equal(r('{{ "The quick brown fox" | truncate: 10 }}|{{ "The quick brown fox" | truncatewords: 2 }}|{{ "short" | truncate: 10 }}|{{ "abcdef" | truncate: 4, "~" }}'), 'The qui...|The quick...|short|abc~');
  assert.equal(r('{{ "a,b,c" | split: "," | reverse | join: "-" }}|{{ xs | sort | join: "" }}|{{ ps | map: "n" | join: "," }}|{{ ps | where: "ok", true | size }}', { xs: ['c', 'a', 'b'], ps: [{ n: 'x', ok: true }, { n: 'y', ok: false }] }), 'c-b-a|abc|x,y|1');
  assert.equal(r('{{ 7 | divided_by: 2 }}|{{ 7.5 | divided_by: 2 }}|{{ 7 | modulo: 4 }}|{{ 3.14159 | round: 2 }}|{{ -3 | abs }}|{{ 2.1 | ceil }}|{{ 2.9 | floor }}|{{ "x" | plus: 2 }}'), '3|3.75|3|3.14|3|3|2|2');
  assert.equal(r('{{ nothing | default: "n/a" }}|{{ "" | default: "e" }}|{{ 0 | default: "z" }}|{{ false | default: "f" }}'), 'n/a|e|0|f');
  assert.equal(r('{{ "a b&c" | url_encode }}|{{ "a\\nb" | newline_to_br }}'.replace('\\n', '\n')), 'a%20b%26c|a<br>\nb');
  assert.throws(() => r('{{ 1 | divided_by: 0 }}'), FilterError);
});

test('date uses the injected clock and strftime codes in UTC', () => {
  const r = (t: string) => render(t, { when: '2026-12-25T23:30:00Z', epoch: 0 }, { now: NOW });
  assert.equal(r('{{ "now" | date: "%Y-%m-%d %H:%M:%S" }}'), '2026-03-05 14:07:09');
  assert.equal(r('{{ when | date: "%A, %B %e %Y %I:%M %p" }}'), 'Friday, December 25 2026 11:30 PM');
  assert.equal(r('{{ epoch | date }}'), '1970-01-01');
  assert.equal(r('{{ when | date: "%a %b %j %y %% %Z" }}'), 'Fri Dec 359 26 % UTC');
  assert.throws(() => r('{{ "not a date" | date }}'), /not a date/);
  assert.equal(strftime(new Date('2024-02-29T00:00:00Z'), '%j'), '060');
});

test('whitespace control trims on either side; raw and comment emit as told', () => {
  assert.equal(render('a  {{- "b" -}}  c', {}), 'abc');
  assert.equal(render('x\n  {%- if true -%}\n  y\n  {%- endif -%}\n  z', {}), 'xyz');
  assert.equal(render('{% raw %}{{ not }} {% if %}{% endraw %}!', {}), '{{ not }} {% if %}!');
  assert.equal(render('a{% comment %}{{ hidden }} {% bogus %}{% endcomment %}b', {}), 'ab');
});

test('include shares variables; render sees only what it is passed', () => {
  const e = new Engine({ partials: { greet: 'Hello {{ who }}{% assign seen = "yes" %}', card: '[{{ title }}|{{ outer }}]', 'mail/footer': '-- {{ org }}' } });
  assert.equal(e.render('{% include "greet" %}!{{ seen }}', { who: 'Ana' }), 'Hello Ana!yes');
  assert.equal(e.render('{% include "greet", who: "Bo" %}', { who: 'Ana' }), 'Hello Bo');
  assert.equal(e.render('{% render "card", title: t %}', { t: 'T', outer: 'secret' }), '[T|]', 'render is isolated');
  assert.equal(e.render("{% include 'mail/footer' %}", { org: 'Acme' }), '-- Acme');
  assert.throws(() => e.render('{% include "nope" %}', {}), /no partial named "nope"/);
  for (const bad of ['../etc/passwd', '/abs', 'a//b', 'a b', 'x.html']) assert.throws(() => e.parse(`{% include "${bad}" %}`), TemplateSyntaxError, bad);
});

test('sandbox: runaway recursion, loops, output and templates are refused', () => {
  const rec = new Engine({ partials: { loop: '{% include "loop" %}' } });
  assert.throws(() => rec.render('{% include "loop" %}', {}), /nested more than 8 deep/);
  const e = new Engine({ limits: { maxIterations: 100, maxSteps: 5000, maxOutput: 200, maxTemplate: 100 } });
  assert.throws(() => e.render('{% for i in (1..1000) %}x{% endfor %}', {}), LimitExceeded);
  assert.throws(() => e.render('{% for i in (1..99) %}{% for j in (1..99) %}{% endfor %}{% endfor %}', {}), /loops ran more than 100 passes/);
  assert.throws(() => e.render('{% for i in (1..50) %}0123456789{% endfor %}', {}), /output is longer than 200/);
  assert.throws(() => e.render('{% assign s = "0123456789" %}{% for i in (1..30) %}{% assign s = s | append: s %}{% endfor %}', {}), /longer than 200/);
  assert.throws(() => e.render('x'.repeat(101), {}), /limit is 100/);
  const steps = new Engine({ limits: { maxSteps: 50 } });
  assert.throws(() => steps.render('{% for i in (1..40) %}{{ i | plus: 1 | plus: 1 }}{% endfor %}', {}), /more than 50 steps/);
  assert.throws(() => new Engine({ limits: { maxDepth: 5 } }).parse('{% if a %}'.repeat(10) + '{% endif %}'.repeat(10)), /nested too deeply/);
});

test('syntax errors name the line and say what is wrong', () => {
  const bad = (t: string, re: RegExp) => assert.throws(() => render(t, {}), (e: Error) => e instanceof TemplateSyntaxError && re.test(e.message), t);
  bad('{% if x %}never closed', /line 1: \{% if %\} is never closed/);
  bad('ok\n\n{{ name', /line 3: "\{\{" is never closed/);
  bad('{% endif %}', /no matching opening tag/);
  bad('{% frobnicate %}', /unknown tag "frobnicate"/);
  bad('{{ x | nosuchfilter }}', /unknown filter "nosuchfilter"/);
  bad('{% for x xs %}{% endfor %}', /a loop is written/);
  bad('{{ "open }}', /string is not closed/);
  bad('{{ a b }}', /does not belong/);
  bad('a\nb\n{% if %}{% endif %}', /line 3/);
  bad('{% case x %}junk{% when 1 %}{% endcase %}', /nothing may come between/);
  bad('{{ a ; b }}', /unexpected character ";"/);
});

test('strict mode names what is missing; the default is empty', () => {
  const strict = new Engine({ strict: true });
  assert.throws(() => strict.render('Hi {{ name }}', {}), (e: Error) => e instanceof UndefinedVariable && /line 1: "name" is not defined/.test(e.message));
  assert.throws(() => strict.render('{{ user.email }}', { user: { name: 'a' } }), /"user.email" is not defined/);
  assert.equal(strict.render('{{ user.name }}', { user: { name: 'Ana' } }), 'Ana');
  assert.equal(strict.render('{% assign x = 1 %}{{ x }}', {}), '1');
  assert.equal(render('Hi {{ name }}!', {}), 'Hi !');
});

test('custom filters are added; the filter set is the template author\'s only reach', () => {
  const e = new Engine({ filters: { shout: (v) => `${String(v).toUpperCase()}!` } });
  assert.equal(e.render('{{ "hey" | shout }}', {}), 'HEY!');
  assert.equal(e.render('{{ x | json }}', { x: { a: '</script>', b: [1, null] } }), '{"a":"\\u003c/script\\u003e","b":[1,null]}');
});

test('variables lists what a template needs from outside, leaving out its own', () => {
  const e = new Engine();
  assert.deepEqual(e.variables('Hi {{ user.name }}{% assign t = total | times: rate %}{% for i in items %}{{ i.n }}{{ forloop.index }}{{ t }}{% endfor %}{% if flag %}{{ other[idx] }}{% endif %}'), ['flag', 'idx', 'items', 'other', 'rate', 'total', 'user']);
});

test('validate reports syntax problems without rendering, partials included', () => {
  assert.deepEqual(new Engine().validate('{{ ok }}'), []);
  const errs = new Engine({ partials: { broken: '{% if %}' } }).validate('{{ ok }}');
  assert.equal(errs.length, 1);
  assert.match(errs[0]!.message, /line 1/);
});

test('a template parsed once renders many times with different data', () => {
  const e = new Engine();
  const t = e.parse('{{ a }}-{{ b }}');
  assert.equal(e.render(t, { a: 1, b: 2 }), '1-2');
  assert.equal(e.render(t, { a: 'x', b: 'y' }), 'x-y');
});

test('hostile data in loops and attributes stays escaped', () => {
  const out = render('<a href="/u/{{ id | url_encode }}" title="{{ t }}">{% for x in xs %}<li>{{ x }}</li>{% endfor %}</a>', { id: '1"><script>', t: '" onmouseover="x', xs: ['<img src=x onerror=1>'] });
  assert.equal(out, '<a href="/u/1%22%3E%3Cscript%3E" title="&quot; onmouseover=&quot;x"><li>&lt;img src=x onerror=1&gt;</li></a>');
});
