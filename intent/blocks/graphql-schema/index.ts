/**
 * GraphQL, the parts a service has to get right: a parser for both the schema language (SDL, with descriptions,
 * extensions, interfaces, unions, enums, input objects, custom directives) and query documents (operations,
 * variables, fragments, aliases, directives), a schema builder that checks the schema is coherent (interfaces
 * really implemented, unions of object types, input types only where inputs go), query validation against the
 * rules of the GraphQL specification (known fields, arguments and fragments, leaf selections, variables defined,
 * used and of the right type, literal values of the right type, fragments possible and acyclic, fields that merge),
 * and the limits a public endpoint needs: document size, nesting depth, alias count, and a cost estimate in which
 * list fields multiply their children by `first`/`limit` (or the schema's `@cost(value:, multipliers:)`), plus an
 * introspection switch that refuses `__schema` and `__type` when off. `plan` lists the resolver calls a query
 * would make without making them (for authorisation, batching and tracing), and `execute` runs a query against a
 * map of resolvers with the spec's rules: null propagation through non-null types, errors with paths, serial
 * mutations, @skip/@include, abstract types resolved by `__typename` or `resolveType`, and variable and result
 * coercion. Introspection queries are answered from the schema when enabled.
 *
 * Out of scope: subscriptions (parsed and validated, not executed), @defer/@stream, federation, persisted queries,
 * and the "same response shape" rule across differently-typed overlapping fragments beyond the common cases.
 */

// --- errors ---------------------------------------------------------------------------------------------------------

export interface Location {
  readonly line: number;
  readonly column: number;
}

export class GraphQLError extends Error {
  readonly locations: readonly Location[] | undefined;
  readonly path: readonly (string | number)[] | undefined;
  readonly extensions: Readonly<Record<string, unknown>> | undefined;
  constructor(message: string, o: { locations?: readonly Location[]; path?: readonly (string | number)[]; extensions?: Record<string, unknown> } = {}) {
    super(message);
    this.locations = o.locations;
    this.path = o.path;
    this.extensions = o.extensions;
  }
  toJSON() {
    return { message: this.message, ...(this.locations ? { locations: this.locations } : {}), ...(this.path ? { path: this.path } : {}), ...(this.extensions ? { extensions: this.extensions } : {}) };
  }
}

export class SyntaxError_ extends GraphQLError {}
export { SyntaxError_ as GraphQLSyntaxError };

// --- AST --------------------------------------------------------------------------------------------------------------

export type TypeRef = { kind: 'named'; name: string } | { kind: 'list'; of: TypeRef } | { kind: 'nonNull'; of: TypeRef };

export type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

export interface ArgumentNode {
  name: string;
  value: ValueNode;
}
export interface DirectiveNode {
  name: string;
  args: ArgumentNode[];
  loc: Location;
}
export type SelectionNode = FieldNode | FragmentSpreadNode | InlineFragmentNode;
export interface FieldNode {
  kind: 'field';
  alias?: string;
  name: string;
  args: ArgumentNode[];
  directives: DirectiveNode[];
  selections?: SelectionNode[];
  loc: Location;
}
export interface FragmentSpreadNode {
  kind: 'spread';
  name: string;
  directives: DirectiveNode[];
  loc: Location;
}
export interface InlineFragmentNode {
  kind: 'inline';
  typeCondition?: string;
  directives: DirectiveNode[];
  selections: SelectionNode[];
  loc: Location;
}
export interface VariableDefinition {
  name: string;
  type: TypeRef;
  defaultValue?: ValueNode;
  directives: DirectiveNode[];
  loc: Location;
}
export interface OperationNode {
  kind: 'operation';
  operation: 'query' | 'mutation' | 'subscription';
  name?: string;
  variables: VariableDefinition[];
  directives: DirectiveNode[];
  selections: SelectionNode[];
  loc: Location;
}
export interface FragmentNode {
  kind: 'fragment';
  name: string;
  typeCondition: string;
  directives: DirectiveNode[];
  selections: SelectionNode[];
  loc: Location;
}
export interface InputValueNode {
  name: string;
  description?: string;
  type: TypeRef;
  defaultValue?: ValueNode;
  directives: DirectiveNode[];
}
export interface FieldDefNode {
  name: string;
  description?: string;
  args: InputValueNode[];
  type: TypeRef;
  directives: DirectiveNode[];
}
export interface TypeDefNode {
  kind: 'type';
  typeKind: 'scalar' | 'object' | 'interface' | 'union' | 'enum' | 'input';
  extend: boolean;
  name: string;
  description?: string;
  interfaces: string[];
  directives: DirectiveNode[];
  fields: FieldDefNode[];
  inputFields: InputValueNode[];
  members: string[];
  values: { name: string; description?: string; directives: DirectiveNode[] }[];
  loc: Location;
}
export interface DirectiveDefNode {
  kind: 'directiveDef';
  name: string;
  description?: string;
  args: InputValueNode[];
  repeatable: boolean;
  locations: string[];
  loc: Location;
}
export interface SchemaDefNode {
  kind: 'schemaDef';
  extend: boolean;
  operations: { operation: 'query' | 'mutation' | 'subscription'; type: string }[];
  directives: DirectiveNode[];
  loc: Location;
}
export type DefinitionNode = OperationNode | FragmentNode | TypeDefNode | DirectiveDefNode | SchemaDefNode;
export interface Document {
  definitions: DefinitionNode[];
}

// --- lexer ------------------------------------------------------------------------------------------------------------

interface Token {
  kind: 'punct' | 'name' | 'int' | 'float' | 'string' | 'eof';
  value: string;
  line: number;
  column: number;
}

export interface ParseLimits {
  /** Largest source accepted, in characters (default 100,000). */
  readonly maxSize?: number;
  /** Most tokens accepted (default 20,000). */
  readonly maxTokens?: number;
}

function blockStringValue(raw: string): string {
  const lines = raw.split(/\r\n|\n|\r/);
  let common = Infinity;
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i]!;
    const indent = l.length - l.trimStart().length;
    if (indent < l.length && indent < common) common = indent;
  }
  if (common !== Infinity && common > 0) for (let i = 1; i < lines.length; i++) lines[i] = lines[i]!.slice(common);
  while (lines.length && lines[0]!.trim() === '') lines.shift();
  while (lines.length && lines[lines.length - 1]!.trim() === '') lines.pop();
  return lines.join('\n');
}

function lex(src: string, lim: ParseLimits): Token[] {
  if (src.length > (lim.maxSize ?? 100_000)) throw new SyntaxError_(`the document is longer than ${lim.maxSize ?? 100_000} characters`);
  const maxTokens = lim.maxTokens ?? 20_000;
  const out: Token[] = [];
  let i = src.charCodeAt(0) === 0xfeff ? 1 : 0;
  let line = 1;
  let lineStart = i;
  const fail = (m: string, at = i): never => {
    throw new SyntaxError_(`Syntax Error: ${m}`, { locations: [{ line, column: at - lineStart + 1 }] });
  };
  const push = (kind: Token['kind'], value: string, start: number) => {
    if (out.length >= maxTokens) fail(`more than ${maxTokens} tokens`, start);
    out.push({ kind, value, line, column: start - lineStart + 1 });
  };
  while (i < src.length) {
    const c = src[i]!;
    if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      i++;
      line++;
      lineStart = i;
    } else if (c === ' ' || c === '\t' || c === ',' || c === '﻿') i++;
    else if (c === '#') while (i < src.length && src[i] !== '\n' && src[i] !== '\r') i++;
    else if ('!$&():=@[]{|}'.includes(c)) {
      push('punct', c, i);
      i++;
    } else if (c === '.') {
      if (src.startsWith('...', i)) {
        push('punct', '...', i);
        i += 3;
      } else fail('unexpected "."');
    } else if (/[A-Za-z_]/.test(c)) {
      const s = i;
      while (i < src.length && /[A-Za-z0-9_]/.test(src[i]!)) i++;
      push('name', src.slice(s, i), s);
    } else if (c === '-' || /[0-9]/.test(c)) {
      const s = i;
      const m = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(src.slice(i, i + 400));
      if (!m) fail('invalid number');
      i += m![0].length;
      if (/[A-Za-z_.0-9]/.test(src[i] ?? '')) fail('invalid number, unexpected character after it', i);
      push(m![2] || m![3] ? 'float' : 'int', m![0], s);
    } else if (c === '"') {
      const s = i;
      const startLine = line;
      const startCol = i - lineStart + 1;
      if (src.startsWith('"""', i)) {
        i += 3;
        let raw = '';
        for (;;) {
          if (i >= src.length) fail('unterminated block string', s);
          if (src.startsWith('\\"""', i)) {
            raw += '"""';
            i += 4;
          } else if (src.startsWith('"""', i)) {
            i += 3;
            break;
          } else {
            if (src[i] === '\n') {
              line++;
              lineStart = i + 1;
            }
            raw += src[i++];
          }
        }
        out.push({ kind: 'string', value: blockStringValue(raw), line: startLine, column: startCol });
        if (out.length > maxTokens) fail(`more than ${maxTokens} tokens`, s);
      } else {
        i++;
        let v = '';
        for (;;) {
          const ch = src[i];
          if (ch === undefined || ch === '\n' || ch === '\r') fail('unterminated string', s);
          if (ch === '"') {
            i++;
            break;
          }
          if (ch === '\\') {
            const e = src[i + 1];
            const simple: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
            if (e !== undefined && e in simple) {
              v += simple[e];
              i += 2;
            } else if (e === 'u') {
              let m = /^\{([0-9a-fA-F]{1,6})\}/.exec(src.slice(i + 2, i + 10));
              if (m) {
                const cp = parseInt(m[1]!, 16);
                if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) fail('invalid unicode escape');
                v += String.fromCodePoint(cp);
                i += 2 + m[0].length;
              } else {
                m = /^([0-9a-fA-F]{4})/.exec(src.slice(i + 2, i + 6));
                if (!m) fail('invalid unicode escape');
                v += String.fromCharCode(parseInt(m![1]!, 16));
                i += 6;
              }
            } else fail(`invalid escape \\${e ?? ''}`);
          } else {
            v += ch;
            i++;
          }
        }
        out.push({ kind: 'string', value: v, line: startLine, column: startCol });
        if (out.length > maxTokens) fail(`more than ${maxTokens} tokens`, s);
      }
    } else fail(`unexpected character ${JSON.stringify(c)}`);
  }
  out.push({ kind: 'eof', value: '<EOF>', line, column: i - lineStart + 1 });
  return out;
}

// --- parser -----------------------------------------------------------------------------------------------------------

const BUILTIN_SCALARS = ['Int', 'Float', 'String', 'Boolean', 'ID'];

class Parser {
  private p = 0;
  private readonly t: Token[];
  private depth = 0;
  constructor(t: Token[]) {
    this.t = t;
  }
  private get cur(): Token {
    return this.t[this.p]!;
  }
  private loc(tok = this.cur): Location {
    return { line: tok.line, column: tok.column };
  }
  private fail(m: string, tok = this.cur): never {
    throw new SyntaxError_(`Syntax Error: ${m}`, { locations: [this.loc(tok)] });
  }
  private isP(v: string) {
    return this.cur.kind === 'punct' && this.cur.value === v;
  }
  private isName(v: string) {
    return this.cur.kind === 'name' && this.cur.value === v;
  }
  private expectP(v: string) {
    if (!this.isP(v)) this.fail(`Expected "${v}", found ${this.describe()}`);
    this.p++;
  }
  private describe() {
    return this.cur.kind === 'eof' ? '<EOF>' : `"${this.cur.value}"`;
  }
  private skipP(v: string) {
    if (this.isP(v)) {
      this.p++;
      return true;
    }
    return false;
  }
  private name(): string {
    if (this.cur.kind !== 'name') this.fail(`Expected Name, found ${this.describe()}`);
    return this.t[this.p++]!.value;
  }
  private keyword(v: string) {
    if (!this.isName(v)) this.fail(`Expected "${v}", found ${this.describe()}`);
    this.p++;
  }
  private nest<T>(f: () => T): T {
    if (++this.depth > 200) this.fail('the document is nested too deeply');
    try {
      return f();
    } finally {
      this.depth--;
    }
  }

  document(): Document {
    const definitions: DefinitionNode[] = [];
    if (this.t.length === 1) this.fail('Unexpected <EOF>');
    while (this.cur.kind !== 'eof') definitions.push(this.definition());
    return { definitions };
  }

  private definition(): DefinitionNode {
    const loc = this.loc();
    if (this.isP('{')) return { kind: 'operation', operation: 'query', variables: [], directives: [], selections: this.selectionSet(), loc };
    let description: string | undefined;
    if (this.cur.kind === 'string') description = this.t[this.p++]!.value;
    if (this.cur.kind !== 'name') this.fail(`Unexpected ${this.describe()}`);
    const kw = this.cur.value;
    if (!description && (kw === 'query' || kw === 'mutation' || kw === 'subscription')) return this.operation();
    if (!description && kw === 'fragment') return this.fragment();
    let extend = false;
    if (kw === 'extend') {
      extend = true;
      this.p++;
    }
    const k = this.cur.kind === 'name' ? this.cur.value : '';
    if (k === 'schema') return this.schemaDef(extend, loc);
    if (k === 'scalar' || k === 'type' || k === 'interface' || k === 'union' || k === 'enum' || k === 'input') return this.typeDef(extend, description, loc);
    if (k === 'directive' && !extend) return this.directiveDef(description, loc);
    return this.fail(`Unexpected ${this.describe()}`);
  }

  private operation(): OperationNode {
    const loc = this.loc();
    const operation = this.name() as OperationNode['operation'];
    const name = this.cur.kind === 'name' ? this.name() : undefined;
    const variables: VariableDefinition[] = [];
    if (this.skipP('(')) {
      do {
        const vloc = this.loc();
        this.expectP('$');
        const vn = this.name();
        this.expectP(':');
        const type = this.typeRef();
        const defaultValue = this.skipP('=') ? this.value(true) : undefined;
        const directives = this.directives(true);
        variables.push({ name: vn, type, ...(defaultValue ? { defaultValue } : {}), directives, loc: vloc });
      } while (!this.isP(')'));
      this.expectP(')');
    }
    const directives = this.directives(false);
    return { kind: 'operation', operation, ...(name ? { name } : {}), variables, directives, selections: this.selectionSet(), loc };
  }

  private fragment(): FragmentNode {
    const loc = this.loc();
    this.keyword('fragment');
    const name = this.name();
    if (name === 'on') this.fail('"on" is not a valid fragment name');
    this.keyword('on');
    const typeCondition = this.name();
    const directives = this.directives(false);
    return { kind: 'fragment', name, typeCondition, directives, selections: this.selectionSet(), loc };
  }

  private selectionSet(): SelectionNode[] {
    return this.nest(() => {
      this.expectP('{');
      const out: SelectionNode[] = [];
      do out.push(this.selection());
      while (!this.isP('}'));
      this.expectP('}');
      return out;
    });
  }

  private selection(): SelectionNode {
    const loc = this.loc();
    if (this.skipP('...')) {
      if (this.cur.kind === 'name' && this.cur.value !== 'on') {
        const name = this.name();
        return { kind: 'spread', name, directives: this.directives(false), loc };
      }
      let typeCondition: string | undefined;
      if (this.isName('on')) {
        this.p++;
        typeCondition = this.name();
      }
      const directives = this.directives(false);
      return { kind: 'inline', ...(typeCondition ? { typeCondition } : {}), directives, selections: this.selectionSet(), loc };
    }
    let name = this.name();
    let alias: string | undefined;
    if (this.skipP(':')) {
      alias = name;
      name = this.name();
    }
    const args = this.arguments_(false);
    const directives = this.directives(false);
    const selections = this.isP('{') ? this.selectionSet() : undefined;
    return { kind: 'field', ...(alias ? { alias } : {}), name, args, directives, ...(selections ? { selections } : {}), loc };
  }

  private arguments_(isConst: boolean): ArgumentNode[] {
    const out: ArgumentNode[] = [];
    if (!this.skipP('(')) return out;
    do {
      const name = this.name();
      this.expectP(':');
      out.push({ name, value: this.value(isConst) });
    } while (!this.isP(')'));
    this.expectP(')');
    return out;
  }

  private directives(isConst: boolean): DirectiveNode[] {
    const out: DirectiveNode[] = [];
    while (this.isP('@')) {
      const loc = this.loc();
      this.p++;
      out.push({ name: this.name(), args: this.arguments_(isConst), loc });
    }
    return out;
  }

  private value(isConst: boolean): ValueNode {
    return this.nest((): ValueNode => {
      const t = this.cur;
      if (t.kind === 'punct') {
        if (t.value === '[') {
          this.p++;
          const values: ValueNode[] = [];
          while (!this.isP(']')) values.push(this.value(isConst));
          this.p++;
          return { kind: 'list', values };
        }
        if (t.value === '{') {
          this.p++;
          const fields: { name: string; value: ValueNode }[] = [];
          while (!this.isP('}')) {
            const name = this.name();
            this.expectP(':');
            fields.push({ name, value: this.value(isConst) });
          }
          this.p++;
          return { kind: 'object', fields };
        }
        if (t.value === '$') {
          if (isConst) this.fail('Unexpected variable in a constant value');
          this.p++;
          return { kind: 'variable', name: this.name() };
        }
        return this.fail(`Unexpected ${this.describe()}`);
      }
      this.p++;
      if (t.kind === 'int') return { kind: 'int', value: t.value };
      if (t.kind === 'float') return { kind: 'float', value: t.value };
      if (t.kind === 'string') return { kind: 'string', value: t.value };
      if (t.kind === 'name') {
        if (t.value === 'true' || t.value === 'false') return { kind: 'boolean', value: t.value === 'true' };
        if (t.value === 'null') return { kind: 'null' };
        return { kind: 'enum', value: t.value };
      }
      return this.fail('Unexpected <EOF>', t);
    });
  }

  private typeRef(): TypeRef {
    return this.nest((): TypeRef => {
      let t: TypeRef;
      if (this.skipP('[')) {
        t = { kind: 'list', of: this.typeRef() };
        this.expectP(']');
      } else t = { kind: 'named', name: this.name() };
      if (this.skipP('!')) t = { kind: 'nonNull', of: t };
      return t;
    });
  }

  private inputValueDefs(open: string, close: string): InputValueNode[] {
    const out: InputValueNode[] = [];
    if (!this.skipP(open)) return out;
    do {
      let description: string | undefined;
      if (this.cur.kind === 'string') description = this.t[this.p++]!.value;
      const name = this.name();
      this.expectP(':');
      const type = this.typeRef();
      const defaultValue = this.skipP('=') ? this.value(true) : undefined;
      out.push({ name, ...(description ? { description } : {}), type, ...(defaultValue ? { defaultValue } : {}), directives: this.directives(true) });
    } while (!this.isP(close));
    this.expectP(close);
    return out;
  }

  private schemaDef(extend: boolean, loc: Location): SchemaDefNode {
    this.keyword('schema');
    const directives = this.directives(true);
    const operations: SchemaDefNode['operations'] = [];
    if (this.skipP('{')) {
      do {
        const operation = this.name() as 'query';
        if (!['query', 'mutation', 'subscription'].includes(operation)) this.fail(`Unexpected "${operation}"`);
        this.expectP(':');
        operations.push({ operation, type: this.name() });
      } while (!this.isP('}'));
      this.expectP('}');
    }
    return { kind: 'schemaDef', extend, operations, directives, loc };
  }

  private typeDef(extend: boolean, description: string | undefined, loc: Location): TypeDefNode {
    const keyword = this.name();
    const typeKind = (keyword === 'type' ? 'object' : keyword) as TypeDefNode['typeKind'];
    const name = this.name();
    const node: TypeDefNode = { kind: 'type', typeKind, extend, name, ...(description ? { description } : {}), interfaces: [], directives: [], fields: [], inputFields: [], members: [], values: [], loc };
    if ((typeKind === 'object' || typeKind === 'interface') && this.isName('implements')) {
      this.p++;
      this.skipP('&');
      do node.interfaces.push(this.name());
      while (this.skipP('&'));
    }
    node.directives = this.directives(true);
    if (typeKind === 'object' || typeKind === 'interface') {
      if (this.skipP('{')) {
        do {
          let d: string | undefined;
          if (this.cur.kind === 'string') d = this.t[this.p++]!.value;
          const fname = this.name();
          const args = this.inputValueDefs('(', ')');
          this.expectP(':');
          const type = this.typeRef();
          node.fields.push({ name: fname, ...(d ? { description: d } : {}), args, type, directives: this.directives(true) });
        } while (!this.isP('}'));
        this.expectP('}');
      }
    } else if (typeKind === 'input') node.inputFields = this.inputValueDefs('{', '}');
    else if (typeKind === 'union') {
      if (this.skipP('=')) {
        this.skipP('|');
        do node.members.push(this.name());
        while (this.skipP('|'));
      }
    } else if (typeKind === 'enum') {
      if (this.skipP('{')) {
        do {
          let d: string | undefined;
          if (this.cur.kind === 'string') d = this.t[this.p++]!.value;
          const vn = this.name();
          if (vn === 'true' || vn === 'false' || vn === 'null') this.fail(`Name "${vn}" is reserved and cannot be used for an enum value`);
          node.values.push({ name: vn, ...(d ? { description: d } : {}), directives: this.directives(true) });
        } while (!this.isP('}'));
        this.expectP('}');
      }
    }
    return node;
  }

  private directiveDef(description: string | undefined, loc: Location): DirectiveDefNode {
    this.keyword('directive');
    this.expectP('@');
    const name = this.name();
    const args = this.inputValueDefs('(', ')');
    let repeatable = false;
    if (this.isName('repeatable')) {
      repeatable = true;
      this.p++;
    }
    this.keyword('on');
    this.skipP('|');
    const locations: string[] = [];
    do locations.push(this.name());
    while (this.skipP('|'));
    return { kind: 'directiveDef', name, ...(description ? { description } : {}), args, repeatable, locations, loc };
  }
}

/** Parses SDL or a query document. Throws GraphQLSyntaxError with the position. */
export function parse(source: string, limits: ParseLimits = {}): Document {
  return new Parser(lex(source, limits)).document();
}

// --- schema -----------------------------------------------------------------------------------------------------------

export interface InputValueDef {
  readonly name: string;
  readonly description: string | undefined;
  readonly type: TypeRef;
  readonly defaultValue: ValueNode | undefined;
  readonly deprecated: string | undefined;
}
export interface FieldDef {
  readonly name: string;
  readonly description: string | undefined;
  readonly type: TypeRef;
  readonly args: ReadonlyMap<string, InputValueDef>;
  readonly deprecated: string | undefined;
  /** From `@cost(value:, multipliers:)`. */
  readonly cost: { readonly value: number; readonly multipliers: readonly string[] } | undefined;
}
export interface TypeDef {
  readonly kind: 'scalar' | 'object' | 'interface' | 'union' | 'enum' | 'input';
  readonly name: string;
  readonly description: string | undefined;
  readonly fields: ReadonlyMap<string, FieldDef>;
  readonly inputFields: ReadonlyMap<string, InputValueDef>;
  readonly interfaces: readonly string[];
  readonly members: readonly string[];
  readonly values: ReadonlyMap<string, { description: string | undefined; deprecated: string | undefined }>;
  readonly specifiedBy: string | undefined;
}
export interface DirectiveDef {
  readonly name: string;
  readonly description: string | undefined;
  readonly args: ReadonlyMap<string, InputValueDef>;
  readonly repeatable: boolean;
  readonly locations: readonly string[];
}
export interface Schema {
  readonly types: ReadonlyMap<string, TypeDef>;
  readonly directives: ReadonlyMap<string, DirectiveDef>;
  readonly query: string;
  readonly mutation: string | undefined;
  readonly subscription: string | undefined;
  /** Object types that implement an interface or belong to a union. */
  possibleTypes(abstract: string): readonly string[];
}

const PRELUDE = `
scalar Int
scalar Float
scalar String
scalar Boolean
scalar ID
directive @skip(if: Boolean!) on FIELD | FRAGMENT_SPREAD | INLINE_FRAGMENT
directive @include(if: Boolean!) on FIELD | FRAGMENT_SPREAD | INLINE_FRAGMENT
directive @deprecated(reason: String = "No longer supported") on FIELD_DEFINITION | ARGUMENT_DEFINITION | INPUT_FIELD_DEFINITION | ENUM_VALUE
directive @specifiedBy(url: String!) on SCALAR
directive @cost(value: Int = 1, multipliers: [String!]) on FIELD_DEFINITION
`;

const INTROSPECTION = `
type __Schema { description: String types: [__Type!]! queryType: __Type! mutationType: __Type subscriptionType: __Type directives: [__Directive!]! }
type __Type { kind: __TypeKind! name: String description: String fields(includeDeprecated: Boolean = false): [__Field!] interfaces: [__Type!] possibleTypes: [__Type!] enumValues(includeDeprecated: Boolean = false): [__EnumValue!] inputFields(includeDeprecated: Boolean = false): [__InputValue!] ofType: __Type specifiedByURL: String }
type __Field { name: String! description: String args: [__InputValue!]! type: __Type! isDeprecated: Boolean! deprecationReason: String }
type __InputValue { name: String! description: String type: __Type! defaultValue: String isDeprecated: Boolean! deprecationReason: String }
type __EnumValue { name: String! description: String isDeprecated: Boolean! deprecationReason: String }
type __Directive { name: String! description: String locations: [__DirectiveLocation!]! args: [__InputValue!]! isRepeatable: Boolean! }
enum __TypeKind { SCALAR OBJECT INTERFACE UNION ENUM INPUT_OBJECT LIST NON_NULL }
enum __DirectiveLocation { QUERY MUTATION SUBSCRIPTION FIELD FRAGMENT_DEFINITION FRAGMENT_SPREAD INLINE_FRAGMENT VARIABLE_DEFINITION SCHEMA SCALAR OBJECT FIELD_DEFINITION ARGUMENT_DEFINITION INTERFACE UNION ENUM ENUM_VALUE INPUT_OBJECT INPUT_FIELD_DEFINITION }
`;

export const typeName = (t: TypeRef): string => (t.kind === 'named' ? t.name : t.kind === 'list' ? `[${typeName(t.of)}]` : `${typeName(t.of)}!`);
const named = (t: TypeRef): string => (t.kind === 'named' ? t.name : named(t.of));

function constValue(v: ValueNode | undefined): unknown {
  if (!v) return undefined;
  switch (v.kind) {
    case 'int':
      return Number(v.value);
    case 'float':
      return Number(v.value);
    case 'string':
    case 'enum':
    case 'boolean':
      return v.value;
    case 'null':
      return null;
    case 'list':
      return v.values.map(constValue);
    case 'object':
      return Object.fromEntries(v.fields.map((f) => [f.name, constValue(f.value)]));
    default:
      return undefined;
  }
}

function deprecation(ds: readonly DirectiveNode[]): string | undefined {
  const d = ds.find((x) => x.name === 'deprecated');
  if (!d) return undefined;
  const r = d.args.find((a) => a.name === 'reason');
  return r && r.value.kind === 'string' ? r.value.value : 'No longer supported';
}

/** Builds and checks a schema from SDL. Throws GraphQLError listing every problem found. */
export function buildSchema(sdl: string, o: { limits?: ParseLimits } = {}): Schema {
  const docs = [parse(PRELUDE), parse(INTROSPECTION), parse(sdl, { maxSize: 1_000_000, maxTokens: 200_000, ...o.limits })];
  const errors: string[] = [];
  const nodes = new Map<string, TypeDefNode[]>();
  const directiveDefs = new Map<string, DirectiveDefNode>();
  const roots: { query?: string; mutation?: string; subscription?: string } = {};
  let schemaDefined = false;
  for (const doc of docs)
    for (const d of doc.definitions) {
      if (d.kind === 'type') {
        const list = nodes.get(d.name) ?? [];
        if (!d.extend && list.some((x) => !x.extend)) errors.push(`There can be only one type named "${d.name}".`);
        list.push(d);
        nodes.set(d.name, list);
      } else if (d.kind === 'directiveDef') {
        if (directiveDefs.has(d.name)) errors.push(`There can be only one directive named "@${d.name}".`);
        directiveDefs.set(d.name, d);
      } else if (d.kind === 'schemaDef') {
        if (!d.extend) {
          if (schemaDefined) errors.push('Must provide only one schema definition.');
          schemaDefined = true;
        }
        for (const op of d.operations) roots[op.operation] = op.type;
      } else errors.push('Schema documents may only contain type system definitions.');
    }
  const types = new Map<string, TypeDef>();
  const inputValue = (n: InputValueNode): InputValueDef => ({ name: n.name, description: n.description, type: n.type, defaultValue: n.defaultValue, deprecated: deprecation(n.directives) });
  for (const [name, list] of nodes) {
    const base = list.find((x) => !x.extend);
    if (!base) {
      errors.push(`Cannot extend type "${name}" because it is not defined.`);
      continue;
    }
    for (const x of list) if (x.typeKind !== base.typeKind) errors.push(`Cannot extend ${base.typeKind} "${name}" with a ${x.typeKind} extension.`);
    const fields = new Map<string, FieldDef>();
    const inputFields = new Map<string, InputValueDef>();
    const interfaces: string[] = [];
    const members: string[] = [];
    const values = new Map<string, { description: string | undefined; deprecated: string | undefined }>();
    for (const x of list) {
      for (const i of x.interfaces) if (!interfaces.includes(i)) interfaces.push(i);
      for (const m of x.members) if (!members.includes(m)) members.push(m);
      for (const f of x.fields) {
        if (fields.has(f.name)) errors.push(`Field "${name}.${f.name}" can only be defined once.`);
        const args = new Map<string, InputValueDef>();
        for (const a of f.args) {
          if (args.has(a.name)) errors.push(`Argument "${name}.${f.name}(${a.name}:)" can only be defined once.`);
          args.set(a.name, inputValue(a));
        }
        const cd = f.directives.find((dd) => dd.name === 'cost');
        let cost: FieldDef['cost'];
        if (cd) {
          const v = cd.args.find((a) => a.name === 'value');
          const m = cd.args.find((a) => a.name === 'multipliers');
          cost = { value: v ? Number(constValue(v.value)) : 1, multipliers: m ? (constValue(m.value) as string[]) : [] };
        }
        fields.set(f.name, { name: f.name, description: f.description, type: f.type, args, deprecated: deprecation(f.directives), cost });
      }
      for (const f of x.inputFields) {
        if (inputFields.has(f.name)) errors.push(`Field "${name}.${f.name}" can only be defined once.`);
        inputFields.set(f.name, inputValue(f));
      }
      for (const v of x.values) {
        if (values.has(v.name)) errors.push(`Enum value "${name}.${v.name}" can only be defined once.`);
        values.set(v.name, { description: v.description, deprecated: deprecation(v.directives) });
      }
    }
    const sb = base.directives.find((d) => d.name === 'specifiedBy');
    types.set(name, { kind: base.typeKind, name, description: base.description, fields, inputFields, interfaces, members, values, specifiedBy: sb && sb.args[0]?.value.kind === 'string' ? sb.args[0].value.value : undefined });
  }
  const directives = new Map<string, DirectiveDef>();
  for (const [n, d] of directiveDefs) {
    const args = new Map<string, InputValueDef>();
    for (const a of d.args) args.set(a.name, inputValue(a));
    directives.set(n, { name: n, description: d.description, args, repeatable: d.repeatable, locations: d.locations });
  }
  const q = roots.query ?? (types.has('Query') ? 'Query' : undefined);
  if (!q) errors.push('Query root type must be provided.');
  const m = roots.mutation ?? (types.has('Mutation') ? 'Mutation' : undefined);
  const s = roots.subscription ?? (types.has('Subscription') ? 'Subscription' : undefined);
  for (const r of [q, m, s]) if (r) {
    const t = types.get(r);
    if (!t) errors.push(`Root type "${r}" is not defined.`);
    else if (t.kind !== 'object') errors.push(`Root type "${r}" must be an object type.`);
  }
  const isInput = (n: string) => ['scalar', 'enum', 'input'].includes(types.get(n)?.kind ?? '');
  const isOutput = (n: string) => ['scalar', 'enum', 'object', 'interface', 'union'].includes(types.get(n)?.kind ?? '');
  const known = (t: TypeRef, where: string): boolean => {
    const n = named(t);
    if (!types.has(n)) {
      errors.push(`Unknown type "${n}" (${where}).`);
      return false;
    }
    return true;
  };
  // is `sub` a valid covariant implementation of `sup`
  const subtype = (sub: TypeRef, sup: TypeRef): boolean => {
    if (sup.kind === 'nonNull') return sub.kind === 'nonNull' && subtype(sub.of, sup.of);
    if (sub.kind === 'nonNull') return subtype(sub.of, sup);
    if (sup.kind === 'list') return sub.kind === 'list' && subtype(sub.of, sup.of);
    if (sub.kind === 'list') return false;
    if (sub.name === sup.name) return true;
    const st = types.get(sup.name);
    return !!st && (st.kind === 'interface' ? (types.get(sub.name)?.interfaces.includes(sup.name) ?? false) : st.kind === 'union' && st.members.includes(sub.name));
  };
  for (const t of types.values()) {
    if (t.name.startsWith('__') && !INTROSPECTION.includes(`type ${t.name} `) && !INTROSPECTION.includes(`enum ${t.name} `)) errors.push(`Name "${t.name}" must not begin with "__".`);
    if (t.kind === 'object' || t.kind === 'interface') {
      if (t.fields.size === 0) errors.push(`Type ${t.name} must define one or more fields.`);
      for (const f of t.fields.values()) {
        if (f.name.startsWith('__') && !t.name.startsWith('__')) errors.push(`Name "${t.name}.${f.name}" must not begin with "__".`);
        if (known(f.type, `${t.name}.${f.name}`) && !isOutput(named(f.type))) errors.push(`The type of ${t.name}.${f.name} must be an output type.`);
        for (const a of f.args.values()) if (known(a.type, `${t.name}.${f.name}(${a.name}:)`) && !isInput(named(a.type))) errors.push(`The type of ${t.name}.${f.name}(${a.name}:) must be an input type.`);
      }
      for (const iname of t.interfaces) {
        const it = types.get(iname);
        if (!it) errors.push(`Type ${t.name} implements unknown type ${iname}.`);
        else if (it.kind !== 'interface') errors.push(`Type ${t.name} must only implement interface types, it cannot implement ${iname}.`);
        else {
          for (const itf of it.interfaces) if (!t.interfaces.includes(itf)) errors.push(`Type ${t.name} must implement ${itf} because it is implemented by ${iname}.`);
          for (const f of it.fields.values()) {
            const mine = t.fields.get(f.name);
            if (!mine) errors.push(`Interface field ${iname}.${f.name} expected but ${t.name} does not provide it.`);
            else {
              if (!subtype(mine.type, f.type)) errors.push(`Interface field ${iname}.${f.name} expects type ${typeName(f.type)} but ${t.name}.${f.name} is type ${typeName(mine.type)}.`);
              for (const a of f.args.values()) {
                const ma = mine.args.get(a.name);
                if (!ma) errors.push(`Interface field argument ${iname}.${f.name}(${a.name}:) expected but ${t.name}.${f.name} does not provide it.`);
                else if (typeName(ma.type) !== typeName(a.type)) errors.push(`Interface field argument ${iname}.${f.name}(${a.name}:) expects type ${typeName(a.type)} but ${t.name}.${f.name}(${a.name}:) is type ${typeName(ma.type)}.`);
              }
              for (const ma of mine.args.values()) if (!f.args.has(ma.name) && ma.type.kind === 'nonNull' && !ma.defaultValue) errors.push(`Object field ${t.name}.${f.name} includes required argument ${ma.name} that is missing from the Interface field ${iname}.${f.name}.`);
            }
          }
        }
      }
    } else if (t.kind === 'union') {
      if (t.members.length === 0) errors.push(`Union type ${t.name} must define one or more member types.`);
      for (const mn of t.members) if (types.get(mn)?.kind !== 'object') errors.push(`Union type ${t.name} can only include Object types, it cannot include ${mn}.`);
    } else if (t.kind === 'enum') {
      if (t.values.size === 0) errors.push(`Enum type ${t.name} must define one or more values.`);
    } else if (t.kind === 'input') {
      if (t.inputFields.size === 0) errors.push(`Input Object type ${t.name} must define one or more fields.`);
      for (const f of t.inputFields.values()) if (known(f.type, `${t.name}.${f.name}`) && !isInput(named(f.type))) errors.push(`The type of ${t.name}.${f.name} must be an input type.`);
    }
  }
  for (const d of directives.values()) for (const a of d.args.values()) if (known(a.type, `@${d.name}(${a.name}:)`) && !isInput(named(a.type))) errors.push(`The type of @${d.name}(${a.name}:) must be an input type.`);
  if (errors.length) throw new GraphQLError(`Invalid schema:\n${errors.map((e) => `- ${e}`).join('\n')}`, { extensions: { problems: errors } });
  const possible = new Map<string, string[]>();
  for (const t of types.values()) {
    if (t.kind === 'union') possible.set(t.name, [...t.members]);
    if (t.kind === 'object') for (const i of t.interfaces) (possible.get(i) ?? possible.set(i, []).get(i)!).push(t.name);
  }
  return { types, directives, query: q!, mutation: m, subscription: s, possibleTypes: (a) => possible.get(a) ?? [] };
}

// --- values -----------------------------------------------------------------------------------------------------------

const INT_MAX = 2147483647;
const INT_MIN = -2147483648;
export interface ScalarCoercion {
  parse?(v: unknown): unknown;
  serialize?(v: unknown): unknown;
}

/** Whether a literal fits an input type; returns problems (empty when it fits). Variables are accepted when `variables` is true. */
function literalProblems(schema: Schema, v: ValueNode, t: TypeRef, variables: boolean, scalars: Readonly<Record<string, ScalarCoercion>>): string[] {
  if (v.kind === 'variable') return variables ? [] : ['variables are not allowed here'];
  if (t.kind === 'nonNull') {
    if (v.kind === 'null') return [`Expected value of type "${typeName(t)}", found null.`];
    return literalProblems(schema, v, t.of, variables, scalars);
  }
  if (v.kind === 'null') return [];
  if (t.kind === 'list') {
    if (v.kind === 'list') return v.values.flatMap((x) => literalProblems(schema, x, t.of, variables, scalars));
    return literalProblems(schema, v, t.of, variables, scalars);
  }
  const def = schema.types.get(t.name);
  if (!def) return [`Unknown type "${t.name}".`];
  const show = (x: ValueNode) => (x.kind === 'string' ? JSON.stringify(x.value) : x.kind === 'enum' || x.kind === 'int' || x.kind === 'float' ? x.value : x.kind === 'boolean' ? String(x.value) : x.kind);
  if (def.kind === 'input') {
    if (v.kind !== 'object') return [`Expected value of type "${t.name}", found ${show(v)}.`];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const f of v.fields) {
      if (seen.has(f.name)) out.push(`There can be only one input field named "${f.name}".`);
      seen.add(f.name);
      const fd = def.inputFields.get(f.name);
      if (!fd) out.push(`Field "${f.name}" is not defined by type "${t.name}".`);
      else out.push(...literalProblems(schema, f.value, fd.type, variables, scalars));
    }
    for (const fd of def.inputFields.values()) if (fd.type.kind === 'nonNull' && !fd.defaultValue && !seen.has(fd.name)) out.push(`Field "${t.name}.${fd.name}" of required type "${typeName(fd.type)}" was not provided.`);
    return out;
  }
  if (def.kind === 'enum') {
    if (v.kind !== 'enum') return [`Enum "${t.name}" cannot represent non-enum value: ${show(v)}.`];
    return def.values.has(v.value) ? [] : [`Value "${v.value}" does not exist in "${t.name}" enum.`];
  }
  if (def.kind !== 'scalar') return [`Expected value of type "${t.name}", found ${show(v)}.`];
  const bad = `${t.name} cannot represent value: ${show(v)}`;
  switch (t.name) {
    case 'Int':
      return v.kind === 'int' && Number(v.value) >= INT_MIN && Number(v.value) <= INT_MAX ? [] : [v.kind === 'int' ? `Int cannot represent non 32-bit signed integer value: ${v.value}` : bad];
    case 'Float':
      return v.kind === 'int' || v.kind === 'float' ? [] : [bad];
    case 'String':
      return v.kind === 'string' ? [] : [bad];
    case 'Boolean':
      return v.kind === 'boolean' ? [] : [bad];
    case 'ID':
      return v.kind === 'string' || v.kind === 'int' ? [] : [bad];
    default:
      return scalars[t.name] || def.kind === 'scalar' ? [] : [bad];
  }
}

export interface Variables {
  readonly [name: string]: unknown;
}

/** Turns a literal into a JS value for a type, with variables substituted; undefined means "not provided". */
function valueFromLiteral(schema: Schema, v: ValueNode, t: TypeRef, vars: Variables, scalars: Readonly<Record<string, ScalarCoercion>>): unknown {
  if (v.kind === 'variable') return vars[v.name];
  if (t.kind === 'nonNull') return valueFromLiteral(schema, v, t.of, vars, scalars);
  if (v.kind === 'null') return null;
  if (t.kind === 'list') return v.kind === 'list' ? v.values.map((x) => valueFromLiteral(schema, x, t.of, vars, scalars)) : [valueFromLiteral(schema, v, t.of, vars, scalars)];
  const def = schema.types.get(t.name)!;
  if (def.kind === 'input' && v.kind === 'object') {
    const out: Record<string, unknown> = {};
    for (const fd of def.inputFields.values()) {
      const f = v.fields.find((x) => x.name === fd.name);
      let val = f ? valueFromLiteral(schema, f.value, fd.type, vars, scalars) : undefined;
      if (val === undefined && fd.defaultValue) val = valueFromLiteral(schema, fd.defaultValue, fd.type, {}, scalars);
      if (val !== undefined) out[fd.name] = val;
    }
    return out;
  }
  if (v.kind === 'int') return scalars[t.name]?.parse ? scalars[t.name]!.parse!(Number(v.value)) : t.name === 'ID' ? v.value : Number(v.value);
  if (v.kind === 'float') return scalars[t.name]?.parse ? scalars[t.name]!.parse!(Number(v.value)) : Number(v.value);
  if (v.kind === 'string') return scalars[t.name]?.parse ? scalars[t.name]!.parse!(v.value) : v.value;
  if (v.kind === 'boolean') return scalars[t.name]?.parse ? scalars[t.name]!.parse!(v.value) : v.value;
  if (v.kind === 'enum') return v.value;
  return undefined;
}

/** Coerces a JSON variable value to a type, collecting what is wrong at each path. */
function coerceInput(schema: Schema, value: unknown, t: TypeRef, path: string, errs: string[], scalars: Readonly<Record<string, ScalarCoercion>>): unknown {
  if (t.kind === 'nonNull') {
    if (value === null || value === undefined) {
      errs.push(`${path}: Expected non-nullable type "${typeName(t)}" not to be null.`);
      return undefined;
    }
    return coerceInput(schema, value, t.of, path, errs, scalars);
  }
  if (value === null || value === undefined) return null;
  if (t.kind === 'list') {
    if (Array.isArray(value)) return value.map((x, i) => coerceInput(schema, x, t.of, `${path}[${i}]`, errs, scalars));
    return [coerceInput(schema, value, t.of, path, errs, scalars)];
  }
  const def = schema.types.get(t.name)!;
  if (def.kind === 'input') {
    if (typeof value !== 'object' || Array.isArray(value)) {
      errs.push(`${path}: Expected type "${t.name}" to be an object.`);
      return undefined;
    }
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src)) if (!def.inputFields.has(k)) errs.push(`${path}: Field "${k}" is not defined by type "${t.name}".`);
    for (const fd of def.inputFields.values()) {
      if (src[fd.name] === undefined) {
        if (fd.defaultValue) out[fd.name] = valueFromLiteral(schema, fd.defaultValue, fd.type, {}, scalars);
        else if (fd.type.kind === 'nonNull') errs.push(`${path}.${fd.name}: Expected non-nullable type "${typeName(fd.type)}" not to be null.`);
      } else out[fd.name] = coerceInput(schema, src[fd.name], fd.type, `${path}.${fd.name}`, errs, scalars);
    }
    return out;
  }
  if (def.kind === 'enum') {
    if (typeof value !== 'string' || !def.values.has(value)) errs.push(`${path}: Value ${JSON.stringify(value)} does not exist in "${t.name}" enum.`);
    return value;
  }
  const sc = scalars[t.name];
  if (sc?.parse) {
    try {
      return sc.parse(value);
    } catch (e) {
      errs.push(`${path}: ${(e as Error).message}`);
      return undefined;
    }
  }
  switch (t.name) {
    case 'Int':
      if (typeof value !== 'number' || !Number.isInteger(value) || value < INT_MIN || value > INT_MAX) errs.push(`${path}: Int cannot represent non 32-bit signed integer value: ${JSON.stringify(value)}`);
      return value;
    case 'Float':
      if (typeof value !== 'number' || !Number.isFinite(value)) errs.push(`${path}: Float cannot represent non numeric value: ${JSON.stringify(value)}`);
      return value;
    case 'String':
      if (typeof value !== 'string') errs.push(`${path}: String cannot represent a non string value: ${JSON.stringify(value)}`);
      return value;
    case 'Boolean':
      if (typeof value !== 'boolean') errs.push(`${path}: Boolean cannot represent a non boolean value: ${JSON.stringify(value)}`);
      return value;
    case 'ID':
      if (typeof value === 'number' && Number.isInteger(value)) return String(value);
      if (typeof value !== 'string') errs.push(`${path}: ID cannot represent value: ${JSON.stringify(value)}`);
      return value;
    default:
      return value;
  }
}

// --- validation -------------------------------------------------------------------------------------------------------

export interface Limits {
  /** Nesting depth of fields (fragments counted through). Default: no limit. */
  readonly maxDepth?: number;
  readonly maxAliases?: number;
  /** Cost units; see `analyze`. */
  readonly maxCost?: number;
  /** Refuse `__schema` and `__type` (default false). `__typename` is always allowed. */
  readonly disableIntrospection?: boolean;
  /** Length assumed for a list field with no limit argument (default 10). */
  readonly defaultListSize?: number;
  /** Largest list length used in the estimate, however large `first` is (default 1000). */
  readonly maxListSize?: number;
}

export interface ValidateOptions extends Limits {
  readonly variables?: Variables;
  readonly operationName?: string;
  readonly scalars?: Readonly<Record<string, ScalarCoercion>>;
}

const loc = (n: { loc?: Location }) => (n.loc ? [n.loc] : undefined);

const OP_LOCATION: Record<string, string> = { query: 'QUERY', mutation: 'MUTATION', subscription: 'SUBSCRIPTION' };

/** Validates a query document against the schema. Returns every problem found (empty when the document is valid). */
export function validate(schema: Schema, doc: Document, o: ValidateOptions = {}): GraphQLError[] {
  const errs: GraphQLError[] = [];
  const err = (m: string, n?: { loc?: Location }) => errs.push(new GraphQLError(m, n && loc(n) ? { locations: loc(n)! } : {}));
  const scalars = o.scalars ?? {};
  const ops: OperationNode[] = [];
  const frags = new Map<string, FragmentNode>();
  for (const d of doc.definitions) {
    if (d.kind === 'operation') ops.push(d);
    else if (d.kind === 'fragment') {
      if (frags.has(d.name)) err(`There can be only one fragment named "${d.name}".`, d);
      else frags.set(d.name, d);
    } else err(`The ${d.kind === 'schemaDef' ? 'schema' : d.kind === 'directiveDef' ? `"${d.name}" directive` : `"${d.name}" type`} definition is not executable.`, d);
  }
  const names = new Set<string>();
  for (const op of ops) {
    if (op.name) {
      if (names.has(op.name)) err(`There can be only one operation named "${op.name}".`, op);
      names.add(op.name);
    } else if (ops.length > 1) err('This anonymous operation must be the only defined operation.', op);
  }
  const rootOf = (op: OperationNode) => (op.operation === 'query' ? schema.query : op.operation === 'mutation' ? schema.mutation : schema.subscription);
  const usedFragments = new Set<string>();

  const checkDirectives = (ds: readonly DirectiveNode[], where: string) => {
    const seen = new Map<string, number>();
    for (const d of ds) {
      const def = schema.directives.get(d.name);
      if (!def) {
        err(`Unknown directive "@${d.name}".`, d);
        continue;
      }
      if (!def.locations.includes(where)) err(`Directive "@${d.name}" may not be used on ${where}.`, d);
      seen.set(d.name, (seen.get(d.name) ?? 0) + 1);
      if (seen.get(d.name)! > 1 && !def.repeatable) err(`The directive "@${d.name}" can only be used once at this location.`, d);
      const given = new Set<string>();
      for (const a of d.args) {
        const ad = def.args.get(a.name);
        if (!ad) err(`Unknown argument "${a.name}" on directive "@${d.name}".`, d);
        else for (const p of literalProblems(schema, a.value, ad.type, true, scalars)) err(`Argument "${a.name}" of directive "@${d.name}": ${p}`, d);
        if (given.has(a.name)) err(`There can be only one argument named "${a.name}".`, d);
        given.add(a.name);
      }
      for (const ad of def.args.values()) if (ad.type.kind === 'nonNull' && !ad.defaultValue && !given.has(ad.name)) err(`Directive "@${d.name}" argument "${ad.name}" of type "${typeName(ad.type)}" is required, but it was not provided.`, d);
    }
  };

  const fieldsOf = (t: TypeDef | undefined) => (t && (t.kind === 'object' || t.kind === 'interface') ? t.fields : undefined);
  const metaField = (parent: TypeDef, name: string): FieldDef | undefined => {
    if (parent.name !== schema.query) return undefined;
    const str: TypeRef = { kind: 'nonNull', of: { kind: 'named', name: 'String' } };
    if (name === '__schema') return { name, description: undefined, type: { kind: 'nonNull', of: { kind: 'named', name: '__Schema' } }, args: new Map(), deprecated: undefined, cost: undefined };
    if (name === '__type') return { name, description: undefined, type: { kind: 'named', name: '__Type' }, args: new Map([['name', { name: 'name', description: undefined, type: str, defaultValue: undefined, deprecated: undefined }]]), deprecated: undefined, cost: undefined };
    return undefined;
  };
  const lookup = (parent: TypeDef, name: string) => metaField(parent, name) ?? fieldsOf(parent)?.get(name);
  const overlap = (a: string, b: string): boolean => {
    if (a === b) return true;
    const ta = schema.types.get(a);
    const tb = schema.types.get(b);
    if (!ta || !tb) return false;
    const setOf = (t: TypeDef) => (t.kind === 'object' ? [t.name] : t.kind === 'interface' || t.kind === 'union' ? schema.possibleTypes(t.name) : []);
    const sb = setOf(tb);
    return setOf(ta).some((x) => sb.includes(x));
  };

  const checkSelections = (sels: readonly SelectionNode[], parent: TypeDef) => {
    const responseFields = new Map<string, { field: FieldNode; parent: string; def: FieldDef | undefined }[]>();
    const collect = (ss: readonly SelectionNode[], p: TypeDef, seenFr: Set<string>) => {
      for (const s of ss) {
        if (s.kind === 'field') {
          const key = s.alias ?? s.name;
          (responseFields.get(key) ?? responseFields.set(key, []).get(key)!).push({ field: s, parent: p.name, def: s.name === '__typename' ? undefined : lookup(p, s.name) });
        } else if (s.kind === 'inline') {
          const tc = s.typeCondition ? schema.types.get(s.typeCondition) : p;
          if (tc) collect(s.selections, tc, seenFr);
        } else {
          const f = frags.get(s.name);
          if (f && !seenFr.has(s.name)) {
            seenFr.add(s.name);
            const tc = schema.types.get(f.typeCondition);
            if (tc) collect(f.selections, tc, seenFr);
          }
        }
      }
    };
    for (const s of sels) {
      if (s.kind === 'field') {
        checkDirectives(s.directives, 'FIELD');
        if (s.name === '__typename') {
          if (s.selections) err('Field "__typename" must not have a selection since type "String!" has no subfields.', s);
          continue;
        }
        if ((s.name === '__schema' || s.name === '__type') && parent.name === schema.query && o.disableIntrospection) err('GraphQL introspection is not allowed, but the query contains __schema or __type.', s);
        const def = lookup(parent, s.name);
        if (!def) {
          err(`Cannot query field "${s.name}" on type "${parent.name}".`, s);
          continue;
        }
        const given = new Set<string>();
        for (const a of s.args) {
          const ad = def.args.get(a.name);
          if (!ad) err(`Unknown argument "${a.name}" on field "${parent.name}.${s.name}".`, s);
          else for (const p of literalProblems(schema, a.value, ad.type, true, scalars)) err(`Argument "${a.name}" on field "${parent.name}.${s.name}": ${p}`, s);
          if (given.has(a.name)) err(`There can be only one argument named "${a.name}".`, s);
          given.add(a.name);
        }
        for (const ad of def.args.values()) if (ad.type.kind === 'nonNull' && !ad.defaultValue && !given.has(ad.name)) err(`Field "${s.name}" argument "${ad.name}" of type "${typeName(ad.type)}" is required, but it was not provided.`, s);
        const rt = schema.types.get(named(def.type))!;
        const leaf = rt.kind === 'scalar' || rt.kind === 'enum';
        if (leaf && s.selections) err(`Field "${s.name}" must not have a selection since type "${typeName(def.type)}" has no subfields.`, s);
        else if (!leaf && !s.selections) err(`Field "${s.name}" of type "${typeName(def.type)}" must have a selection of subfields.`, s);
        else if (s.selections) checkSelections(s.selections, rt);
      } else if (s.kind === 'inline') {
        checkDirectives(s.directives, 'INLINE_FRAGMENT');
        let target = parent;
        if (s.typeCondition) {
          const tc = schema.types.get(s.typeCondition);
          if (!tc) {
            err(`Unknown type "${s.typeCondition}".`, s);
            continue;
          }
          if (tc.kind === 'scalar' || tc.kind === 'enum' || tc.kind === 'input') {
            err(`Fragment cannot condition on non composite type "${s.typeCondition}".`, s);
            continue;
          }
          if (!overlap(parent.name, tc.name)) err(`Fragment cannot be spread here as objects of type "${parent.name}" can never be of type "${tc.name}".`, s);
          target = tc;
        }
        checkSelections(s.selections, target);
      } else {
        checkDirectives(s.directives, 'FRAGMENT_SPREAD');
        usedFragments.add(s.name);
        const f = frags.get(s.name);
        if (!f) {
          err(`Unknown fragment "${s.name}".`, s);
          continue;
        }
        const tc = schema.types.get(f.typeCondition);
        if (tc && !overlap(parent.name, tc.name)) err(`Fragment "${s.name}" cannot be spread here as objects of type "${parent.name}" can never be of type "${f.typeCondition}".`, s);
      }
    }
    collect(sels, parent, new Set());
    for (const [key, list] of responseFields) {
      const first = list[0]!;
      for (const other of list.slice(1)) {
        const bothObjects = schema.types.get(first.parent)?.kind === 'object' && schema.types.get(other.parent)?.kind === 'object';
        const sameParent = first.parent === other.parent || !bothObjects;
        if (!sameParent) continue;
        if (first.field.name !== other.field.name) err(`Fields "${key}" conflict because "${first.field.name}" and "${other.field.name}" are different fields.`, other.field);
        else if (JSON.stringify(first.field.args.map((a) => [a.name, a.value]).sort()) !== JSON.stringify(other.field.args.map((a) => [a.name, a.value]).sort())) err(`Fields "${key}" conflict because they have differing arguments.`, other.field);
        else if (first.def && other.def) {
          const leaf = (d: FieldDef) => ['scalar', 'enum'].includes(schema.types.get(named(d.type))?.kind ?? '');
          if (typeName(first.def.type) !== typeName(other.def.type) && (leaf(first.def) || leaf(other.def))) err(`Fields "${key}" conflict because they return conflicting types "${typeName(first.def.type)}" and "${typeName(other.def.type)}".`, other.field);
        }
      }
    }
  };

  const collectVars = (v: ValueNode, into: Set<string>) => {
    if (v.kind === 'variable') into.add(v.name);
    else if (v.kind === 'list') v.values.forEach((x) => collectVars(x, into));
    else if (v.kind === 'object') v.fields.forEach((f) => collectVars(f.value, into));
  };
  interface Position {
    readonly name: string;
    readonly type: TypeRef;
    readonly hasDefault: boolean;
    readonly node: { loc?: Location };
  }
  const positionsIn = (v: ValueNode, t: TypeRef, hasDefault: boolean, node: { loc?: Location }, out: Position[]) => {
    if (v.kind === 'variable') return void out.push({ name: v.name, type: t, hasDefault, node });
    const inner = t.kind === 'nonNull' ? t.of : t;
    if (v.kind === 'list' && inner.kind === 'list') v.values.forEach((x) => positionsIn(x, inner.of, false, node, out));
    else if (v.kind === 'object' && inner.kind === 'named') {
      const def = schema.types.get(inner.name);
      if (def?.kind === 'input') for (const f of v.fields) {
        const fd = def.inputFields.get(f.name);
        if (fd) positionsIn(f.value, fd.type, fd.defaultValue !== undefined, node, out);
      }
    }
  };
  /** Variables used, and where, by a selection set and every fragment reachable from it. */
  const walkVars = (sels: readonly SelectionNode[], parent: TypeDef, used: Set<string>, out: Position[], seenFrags: Set<string>) => {
    for (const s of sels) {
      for (const d of s.directives) for (const a of d.args) {
        collectVars(a.value, used);
        const ad = schema.directives.get(d.name)?.args.get(a.name);
        if (ad) positionsIn(a.value, ad.type, ad.defaultValue !== undefined, d, out);
      }
      if (s.kind === 'field') {
        for (const a of s.args) collectVars(a.value, used);
        const def = s.name === '__typename' ? undefined : lookup(parent, s.name);
        if (!def) continue;
        for (const a of s.args) {
          const ad = def.args.get(a.name);
          if (ad) positionsIn(a.value, ad.type, ad.defaultValue !== undefined, s, out);
        }
        const rt = schema.types.get(named(def.type));
        if (s.selections && rt) walkVars(s.selections, rt, used, out, seenFrags);
      } else if (s.kind === 'inline') walkVars(s.selections, (s.typeCondition ? schema.types.get(s.typeCondition) : undefined) ?? parent, used, out, seenFrags);
      else if (!seenFrags.has(s.name)) {
        seenFrags.add(s.name);
        const f = frags.get(s.name);
        const tc = f ? schema.types.get(f.typeCondition) : undefined;
        if (f && tc) walkVars(f.selections, tc, used, out, seenFrags);
      }
    }
  };
  const sub = (a: TypeRef, b: TypeRef): boolean => {
    if (b.kind === 'nonNull') return a.kind === 'nonNull' && sub(a.of, b.of);
    if (a.kind === 'nonNull') return sub(a.of, b);
    if (b.kind === 'list') return a.kind === 'list' && sub(a.of, b.of);
    if (a.kind === 'list') return false;
    return a.name === b.name;
  };
  const varAllowed = (def: VariableDefinition, at: TypeRef, atHasDefault: boolean): boolean => {
    if (at.kind === 'nonNull' && def.type.kind !== 'nonNull') {
      const hasDefault = def.defaultValue !== undefined && def.defaultValue.kind !== 'null';
      return (hasDefault || atHasDefault) && sub(def.type, at.of);
    }
    return sub(def.type, at);
  };

  // fragment spreads, cycles
  const fragmentSpreads = new Map<string, Set<string>>();
  for (const f of frags.values()) {
    const spreads = new Set<string>();
    const walk = (ss: readonly SelectionNode[]) => {
      for (const s of ss) {
        if (s.kind === 'field' && s.selections) walk(s.selections);
        else if (s.kind === 'inline') walk(s.selections);
        else if (s.kind === 'spread') spreads.add(s.name);
      }
    };
    walk(f.selections);
    fragmentSpreads.set(f.name, spreads);
  }
  const state = new Map<string, number>();
  const cyc = (n: string, stack: string[]) => {
    state.set(n, 1);
    for (const m of fragmentSpreads.get(n) ?? []) {
      if (!frags.has(m)) continue;
      if (state.get(m) === 1) err(`Cannot spread fragment "${m}" within itself.`, frags.get(m));
      else if (!state.has(m)) cyc(m, [...stack, n]);
    }
    state.set(n, 2);
  };
  for (const n of frags.keys()) if (!state.has(n)) cyc(n, []);

  for (const f of frags.values()) {
    const tc = schema.types.get(f.typeCondition);
    if (!tc) err(`Unknown type "${f.typeCondition}".`, f);
    else if (!['object', 'interface', 'union'].includes(tc.kind)) err(`Fragment "${f.name}" cannot condition on non composite type "${f.typeCondition}".`, f);
    else {
      checkDirectives(f.directives, 'FRAGMENT_DEFINITION');
      checkSelections(f.selections, tc);
    }
  }

  for (const op of ops) {
    const rootName = rootOf(op);
    const root = rootName ? schema.types.get(rootName) : undefined;
    if (!root) {
      err(`Schema is not configured for ${op.operation}s.`, op);
      continue;
    }
    checkDirectives(op.directives, OP_LOCATION[op.operation]!);
    const vars = new Map<string, VariableDefinition>();
    for (const v of op.variables) {
      if (vars.has(v.name)) err(`There can be only one variable named "$${v.name}".`, v);
      vars.set(v.name, v);
      const n = named(v.type);
      const tdef = schema.types.get(n);
      if (!tdef) err(`Unknown type "${n}".`, v);
      else if (!['scalar', 'enum', 'input'].includes(tdef.kind)) err(`Variable "$${v.name}" cannot be non-input type "${typeName(v.type)}".`, v);
      else if (v.defaultValue) for (const p of literalProblems(schema, v.defaultValue, v.type, false, scalars)) err(`Variable "$${v.name}" of type "${typeName(v.type)}" has an invalid default value: ${p}`, v);
      checkDirectives(v.directives, 'VARIABLE_DEFINITION');
    }
    if (op.operation === 'subscription') {
      const keys = new Set(op.selections.filter((s): s is FieldNode => s.kind === 'field').map((s) => s.alias ?? s.name));
      if (op.selections.length !== 1 || keys.size !== 1) err(op.name ? `Subscription "${op.name}" must select only one top level field.` : 'Anonymous Subscription must select only one top level field.', op);
    }
    checkSelections(op.selections, root);
    const used = new Set<string>();
    const positions: Position[] = [];
    walkVars(op.selections, root, used, positions, new Set());
    for (const u of used) if (!vars.has(u)) err(op.name ? `Variable "$${u}" is not defined by operation "${op.name}".` : `Variable "$${u}" is not defined.`, op);
    for (const v of op.variables) if (!used.has(v.name)) err(op.name ? `Variable "$${v.name}" is never used in operation "${op.name}".` : `Variable "$${v.name}" is never used.`, v);
    for (const pos of positions) {
      const def = vars.get(pos.name);
      if (def && !varAllowed(def, pos.type, pos.hasDefault)) err(`Variable "$${pos.name}" of type "${typeName(def.type)}" used in position expecting type "${typeName(pos.type)}".`, pos.node);
    }
  }

  for (const f of frags.values()) if (!usedFragments.has(f.name)) err(`Fragment "${f.name}" is never used.`, f);

  // limits
  if (!errs.length && (o.maxDepth !== undefined || o.maxAliases !== undefined || o.maxCost !== undefined)) {
    for (const op of ops.filter((x) => !o.operationName || x.name === o.operationName)) {
      const a = analyzeOperation(schema, op, frags, o);
      if (o.maxDepth !== undefined && a.depth > o.maxDepth) errs.push(new GraphQLError(`Query depth ${a.depth} exceeds the maximum of ${o.maxDepth}.`, { extensions: { code: 'DEPTH_LIMIT_EXCEEDED' } }));
      if (o.maxAliases !== undefined && a.aliases > o.maxAliases) errs.push(new GraphQLError(`Query uses ${a.aliases} aliases, more than the maximum of ${o.maxAliases}.`, { extensions: { code: 'ALIAS_LIMIT_EXCEEDED' } }));
      if (o.maxCost !== undefined && a.cost > o.maxCost) errs.push(new GraphQLError(`Query cost ${a.cost} exceeds the maximum of ${o.maxCost}.`, { extensions: { code: 'COST_LIMIT_EXCEEDED', cost: a.cost } }));
    }
  }
  return errs;
}

// --- analysis -----------------------------------------------------------------------------------------------------------

export interface Analysis {
  readonly depth: number;
  readonly aliases: number;
  readonly cost: number;
  /** Number of fields selected (counting each use through a fragment). */
  readonly fields: number;
}

const truthy = (ds: readonly DirectiveNode[], vars: Variables): boolean => {
  for (const d of ds) {
    const arg = d.args.find((a) => a.name === 'if');
    if (!arg) continue;
    const v = arg.value.kind === 'variable' ? vars[arg.value.name] : arg.value.kind === 'boolean' ? arg.value.value : undefined;
    if (d.name === 'skip' && v === true) return false;
    if (d.name === 'include' && v === false) return false;
  }
  return true;
};

function analyzeOperation(schema: Schema, op: OperationNode, frags: ReadonlyMap<string, FragmentNode>, o: Limits & { variables?: Variables }): Analysis {
  const vars = o.variables ?? {};
  const defaultSize = o.defaultListSize ?? 10;
  const maxList = o.maxListSize ?? 1000;
  let aliases = 0;
  let fields = 0;
  let maxDepth = 0;
  const argInt = (f: FieldNode, name: string): number | undefined => {
    const a = f.args.find((x) => x.name === name);
    if (!a) return undefined;
    const v = a.value.kind === 'variable' ? vars[a.value.name] : a.value.kind === 'int' ? Number(a.value.value) : undefined;
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  };
  const walk = (sels: readonly SelectionNode[], parent: TypeDef | undefined, depth: number, stack: readonly string[]): number => {
    let total = 0;
    for (const s of sels) {
      if (!truthy(s.directives, vars)) continue;
      if (s.kind === 'field') {
        fields++;
        if (s.alias && s.alias !== s.name) aliases++;
        if (s.name === '__typename') {
          maxDepth = Math.max(maxDepth, depth + 1);
          continue;
        }
        const fd = parent?.kind === 'object' || parent?.kind === 'interface' ? parent.fields.get(s.name) : undefined;
        const meta = s.name === '__schema' || s.name === '__type';
        const d = depth + 1;
        maxDepth = Math.max(maxDepth, d);
        const unitCost = fd?.cost?.value ?? (meta ? 1 : 1);
        let child = 0;
        const rt = fd ? schema.types.get(named(fd.type)) : meta ? schema.types.get(s.name === '__schema' ? '__Schema' : '__Type') : undefined;
        if (s.selections) child = walk(s.selections, rt, d, stack);
        let mult = 1;
        const isList = fd ? (fd.type.kind === 'nonNull' ? fd.type.of.kind === 'list' : fd.type.kind === 'list') : meta;
        if (isList) {
          const names = fd?.cost?.multipliers.length ? fd.cost.multipliers : ['first', 'last', 'limit', 'take', 'pageSize'];
          let n: number | undefined;
          for (const nm of names) {
            n = argInt(s, nm);
            if (n !== undefined) break;
          }
          mult = Math.min(maxList, Math.max(0, n ?? defaultSize));
        }
        total += unitCost + mult * child;
      } else if (s.kind === 'inline') {
        const tc = s.typeCondition ? schema.types.get(s.typeCondition) : parent;
        total += walk(s.selections, tc, depth, stack);
      } else {
        const f = frags.get(s.name);
        if (!f || stack.includes(s.name)) continue;
        total += walk(f.selections, schema.types.get(f.typeCondition), depth, [...stack, s.name]);
      }
    }
    return total;
  };
  const root = schema.types.get(op.operation === 'query' ? schema.query : (op.operation === 'mutation' ? schema.mutation : schema.subscription) ?? '');
  const cost = walk(op.selections, root, 0, []);
  return { depth: maxDepth, aliases, cost, fields };
}

/** Depth, alias count and cost of an operation (the named one, or the only one). Variables feed the list multipliers. */
export function analyze(schema: Schema, doc: Document, o: Limits & { variables?: Variables; operationName?: string } = {}): Analysis {
  const op = pickOperation(doc, o.operationName);
  const frags = new Map(doc.definitions.filter((d): d is FragmentNode => d.kind === 'fragment').map((f) => [f.name, f]));
  return analyzeOperation(schema, op, frags, o);
}

function pickOperation(doc: Document, name?: string): OperationNode {
  const ops = doc.definitions.filter((d): d is OperationNode => d.kind === 'operation');
  if (name) {
    const op = ops.find((x) => x.name === name);
    if (!op) throw new GraphQLError(`Unknown operation named "${name}".`);
    return op;
  }
  if (ops.length === 0) throw new GraphQLError('Must provide an operation.');
  if (ops.length > 1) throw new GraphQLError('Must provide operation name if query contains multiple operations.');
  return ops[0]!;
}

// --- planning and execution -------------------------------------------------------------------------------------------

export interface PlanNode {
  readonly path: readonly string[];
  readonly responseKey: string;
  readonly parentType: string;
  readonly field: string;
  readonly returnType: string;
  /** Arguments as the resolver will receive them (variables substituted, defaults applied). */
  readonly args: Readonly<Record<string, unknown>>;
  /** For fields under a fragment on an abstract type: the type the fields apply to. */
  readonly typeCondition: string | undefined;
  readonly children: readonly PlanNode[];
}

export interface ExecuteOptions extends ValidateOptions {
  readonly variables?: Variables;
  readonly rootValue?: unknown;
  readonly context?: unknown;
  readonly resolvers?: Readonly<Record<string, Readonly<Record<string, Resolver>>>>;
  /** For abstract types whose values carry no `__typename`. */
  readonly resolveType?: Readonly<Record<string, (value: unknown, context: unknown) => string | undefined>>;
  /** Refuse to start when validation fails (default true). */
  readonly validate?: boolean;
}

export interface ResolveInfo {
  readonly fieldName: string;
  readonly parentType: string;
  readonly returnType: string;
  readonly path: readonly (string | number)[];
  readonly schema: Schema;
  readonly operation: OperationNode;
  readonly variables: Variables;
}
export type Resolver = (source: any, args: any, context: any, info: ResolveInfo) => unknown;

export interface ExecutionResult {
  readonly data?: Record<string, unknown> | null;
  readonly errors?: readonly GraphQLError[];
}

function coerceVariables(schema: Schema, op: OperationNode, given: Variables, scalars: Readonly<Record<string, ScalarCoercion>>): { vars: Variables; errors: GraphQLError[] } {
  const out: Record<string, unknown> = {};
  const problems: string[] = [];
  for (const d of op.variables) {
    const present = Object.prototype.hasOwnProperty.call(given, d.name) && given[d.name] !== undefined;
    if (!present) {
      if (d.defaultValue) out[d.name] = valueFromLiteral(schema, d.defaultValue, d.type, {}, scalars);
      else if (d.type.kind === 'nonNull') problems.push(`Variable "$${d.name}" of required type "${typeName(d.type)}" was not provided.`);
      continue;
    }
    const errs: string[] = [];
    const v = coerceInput(schema, given[d.name], d.type, `Variable "$${d.name}"`, errs, scalars);
    if (errs.length) problems.push(...errs.map((e) => e.replace(/^(Variable "\$[^"]+")([^:]*): /, '$1$2 got invalid value: ')));
    else out[d.name] = v;
  }
  return { vars: out, errors: problems.map((m) => new GraphQLError(m)) };
}

function argValues(schema: Schema, def: FieldDef, node: FieldNode, vars: Variables, scalars: Readonly<Record<string, ScalarCoercion>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const ad of def.args.values()) {
    const given = node.args.find((a) => a.name === ad.name);
    let v: unknown;
    if (given) {
      v = valueFromLiteral(schema, given.value, ad.type, vars, scalars);
      if (v === undefined && given.value.kind === 'variable' && ad.defaultValue) v = valueFromLiteral(schema, ad.defaultValue, ad.type, {}, scalars);
    } else if (ad.defaultValue) v = valueFromLiteral(schema, ad.defaultValue, ad.type, {}, scalars);
    if (v === undefined) {
      if (ad.type.kind === 'nonNull' && !given) throw new GraphQLError(`Argument "${ad.name}" of required type "${typeName(ad.type)}" was not provided.`, { locations: [node.loc] });
      continue;
    }
    if (v === null && ad.type.kind === 'nonNull') throw new GraphQLError(`Argument "${ad.name}" of non-null type "${typeName(ad.type)}" must not be null.`, { locations: [node.loc] });
    out[ad.name] = v;
  }
  return out;
}

class Exec {
  readonly errors: GraphQLError[] = [];
  readonly frags: Map<string, FragmentNode>;
  vars: Variables = {};
  readonly schema: Schema;
  readonly doc: Document;
  readonly op: OperationNode;
  readonly o: ExecuteOptions;
  readonly scalars: Readonly<Record<string, ScalarCoercion>>;
  constructor(schema: Schema, doc: Document, op: OperationNode, o: ExecuteOptions, scalars: Readonly<Record<string, ScalarCoercion>>) {
    this.schema = schema;
    this.doc = doc;
    this.op = op;
    this.o = o;
    this.scalars = scalars;
    this.frags = new Map(doc.definitions.filter((d): d is FragmentNode => d.kind === 'fragment').map((f) => [f.name, f]));
  }

  applies(obj: TypeDef, cond: string | undefined): boolean {
    if (!cond || cond === obj.name) return true;
    const t = this.schema.types.get(cond);
    if (!t) return false;
    if (t.kind === 'interface') return obj.interfaces.includes(cond);
    if (t.kind === 'union') return t.members.includes(obj.name);
    return false;
  }

  collect(obj: TypeDef, sels: readonly SelectionNode[], into: Map<string, FieldNode[]>, visited: Set<string>): void {
    for (const s of sels) {
      if (!truthy(s.directives, this.vars)) continue;
      if (s.kind === 'field') (into.get(s.alias ?? s.name) ?? into.set(s.alias ?? s.name, []).get(s.alias ?? s.name)!).push(s);
      else if (s.kind === 'inline') {
        if (this.applies(obj, s.typeCondition)) this.collect(obj, s.selections, into, visited);
      } else {
        if (visited.has(s.name)) continue;
        const f = this.frags.get(s.name);
        if (!f) continue;
        visited.add(s.name);
        if (this.applies(obj, f.typeCondition)) this.collect(obj, f.selections, into, visited);
      }
    }
  }

  fieldDef(parent: TypeDef, name: string): FieldDef | undefined {
    if (name === '__typename') return { name, description: undefined, type: { kind: 'nonNull', of: { kind: 'named', name: 'String' } }, args: new Map(), deprecated: undefined, cost: undefined };
    if (parent.name === this.schema.query) {
      if (name === '__schema') return { name, description: undefined, type: { kind: 'nonNull', of: { kind: 'named', name: '__Schema' } }, args: new Map(), deprecated: undefined, cost: undefined };
      if (name === '__type') return { name, description: undefined, type: { kind: 'named', name: '__Type' }, args: new Map([['name', { name: 'name', description: undefined, type: { kind: 'nonNull', of: { kind: 'named', name: 'String' } }, defaultValue: undefined, deprecated: undefined }]]), deprecated: undefined, cost: undefined };
    }
    return parent.fields.get(name);
  }

  async executeObject(obj: TypeDef, source: unknown, sels: readonly SelectionNode[], path: (string | number)[], serial: boolean): Promise<Record<string, unknown>> {
    const fields = new Map<string, FieldNode[]>();
    this.collect(obj, sels, fields, new Set());
    const out: Record<string, unknown> = {};
    const run = async (key: string, nodes: FieldNode[]) => {
      const v = await this.executeField(obj, source, nodes, [...path, key]);
      if (v !== undefined) out[key] = v;
    };
    if (serial) for (const [k, n] of fields) await run(k, n);
    else {
      const entries = [...fields];
      for (const [k] of entries) out[k] = null;
      await Promise.all(entries.map(([k, n]) => run(k, n)));
    }
    return out;
  }

  /** Returns undefined only when the field is unknown (a validated query never reaches that). */
  async executeField(parent: TypeDef, source: unknown, nodes: FieldNode[], path: (string | number)[]): Promise<unknown> {
    const node = nodes[0]!;
    const def = this.fieldDef(parent, node.name);
    if (!def) return undefined;
    const retNamed = named(def.type);
    const nullable = def.type.kind !== 'nonNull';
    try {
      let result: unknown;
      if (node.name === '__typename') result = parent.name;
      else {
        const args = argValues(this.schema, def, node, this.vars, this.scalars);
        const info: ResolveInfo = { fieldName: node.name, parentType: parent.name, returnType: typeName(def.type), path, schema: this.schema, operation: this.op, variables: this.vars };
        const resolver = this.o.resolvers?.[parent.name]?.[node.name];
        if (parent.name === this.schema.query && (node.name === '__schema' || node.name === '__type')) result = node.name === '__schema' ? introspectionSchema(this.schema) : (args['name'] !== undefined && this.schema.types.has(String(args['name'])) ? typeObj(this.schema, { kind: 'named', name: String(args['name']) }) : null);
        else if (resolver) result = await resolver(source, args, this.o.context, info);
        else if (source !== null && typeof source === 'object') {
          const p = (source as Record<string, unknown>)[node.name];
          result = typeof p === 'function' ? await (p as Resolver).call(source, source, args, this.o.context, info) : p;
        } else result = undefined;
      }
      return await this.complete(def.type, nodes, result, path);
    } catch (e) {
      const err = e instanceof GraphQLError && e.path ? e : new GraphQLError(e instanceof Error ? e.message : String(e), { path, locations: [node.loc], ...(e instanceof GraphQLError && e.extensions ? { extensions: e.extensions as Record<string, unknown> } : {}) });
      if (!nullable) throw err;
      this.errors.push(err);
      void retNamed;
      return null;
    }
  }

  async complete(t: TypeRef, nodes: FieldNode[], value: unknown, path: (string | number)[]): Promise<unknown> {
    if (value instanceof Error) throw value;
    if (t.kind === 'nonNull') {
      const v = await this.complete(t.of, nodes, value, path);
      if (v === null) throw new GraphQLError(`Cannot return null for non-nullable field ${path.filter((x) => typeof x === 'string').slice(-1)[0] ?? ''}.`, { path, locations: [nodes[0]!.loc] });
      return v;
    }
    if (value === null || value === undefined) return null;
    if (t.kind === 'list') {
      if (typeof value !== 'object' || typeof (value as Iterable<unknown>)[Symbol.iterator] !== 'function') throw new GraphQLError('Expected Iterable, but did not find one for field.', { path, locations: [nodes[0]!.loc] });
      const items = [...(value as Iterable<unknown>)];
      return Promise.all(
        items.map(async (item, i) => {
          const ip = [...path, i];
          try {
            return await this.complete(t.of, nodes, item, ip);
          } catch (e) {
            const err = e instanceof GraphQLError && e.path ? e : new GraphQLError(e instanceof Error ? e.message : String(e), { path: ip, locations: [nodes[0]!.loc] });
            if (t.of.kind === 'nonNull') throw err;
            this.errors.push(err);
            return null;
          }
        }),
      );
    }
    const def = this.schema.types.get(t.name)!;
    if (def.kind === 'scalar' || def.kind === 'enum') return this.serialize(def, value, path, nodes[0]!);
    let obj: TypeDef | undefined = def.kind === 'object' ? def : undefined;
    if (def.kind === 'interface' || def.kind === 'union') {
      let n: string | undefined = this.o.resolveType?.[def.name]?.(value, this.o.context);
      if (n === undefined && typeof value === 'object' && typeof (value as { __typename?: unknown }).__typename === 'string') n = (value as { __typename: string }).__typename;
      if (n === undefined) throw new GraphQLError(`Abstract type "${def.name}" must resolve to an Object type at runtime for field. Either the value needs a "__typename" or the type needs a resolveType.`, { path, locations: [nodes[0]!.loc] });
      obj = this.schema.types.get(n);
      if (!obj || obj.kind !== 'object') throw new GraphQLError(`Abstract type "${def.name}" was resolved to a type "${n}" that does not exist inside the schema.`, { path, locations: [nodes[0]!.loc] });
      if (!this.schema.possibleTypes(def.name).includes(n)) throw new GraphQLError(`Runtime Object type "${n}" is not a possible type for "${def.name}".`, { path, locations: [nodes[0]!.loc] });
    }
    const subs = nodes.flatMap((n) => n.selections ?? []);
    return this.executeObject(obj!, value, subs, path, false);
  }

  serialize(def: TypeDef, v: unknown, path: (string | number)[], node: FieldNode): unknown {
    const fail = (m: string): never => {
      throw new GraphQLError(m, { path, locations: [node.loc] });
    };
    if (def.kind === 'enum') {
      if (typeof v === 'string' && def.values.has(v)) return v;
      return fail(`Enum "${def.name}" cannot represent value: ${JSON.stringify(v)}`);
    }
    const sc = this.scalars[def.name];
    if (sc?.serialize) {
      try {
        return sc.serialize(v);
      } catch (e) {
        return fail((e as Error).message);
      }
    }
    switch (def.name) {
      case 'Int':
        if (typeof v === 'boolean') return v ? 1 : 0;
        if (typeof v === 'number' && Number.isInteger(v) && v >= INT_MIN && v <= INT_MAX) return v;
        return fail(`Int cannot represent non-integer value: ${JSON.stringify(v)}`);
      case 'Float':
        if (typeof v === 'number' && Number.isFinite(v)) return v;
        return fail(`Float cannot represent non numeric value: ${JSON.stringify(v)}`);
      case 'String':
        if (typeof v === 'string') return v;
        if (typeof v === 'number' || typeof v === 'boolean') return String(v);
        return fail(`String cannot represent value: ${JSON.stringify(v)}`);
      case 'Boolean':
        if (typeof v === 'boolean') return v;
        return fail(`Boolean cannot represent a non boolean value: ${JSON.stringify(v)}`);
      case 'ID':
        if (typeof v === 'string') return v;
        if (typeof v === 'number' && Number.isInteger(v)) return String(v);
        return fail(`ID cannot represent value: ${JSON.stringify(v)}`);
      default:
        return v;
    }
  }
}

/** Parses, validates and runs a query. Request-level problems come back as `errors` with no `data`. */
export async function execute(schema: Schema, source: string | Document, o: ExecuteOptions = {}): Promise<ExecutionResult> {
  let doc: Document;
  try {
    doc = typeof source === 'string' ? parse(source) : source;
  } catch (e) {
    return { errors: [e as GraphQLError] };
  }
  const scalars = o.scalars ?? {};
  if (o.validate !== false) {
    const errs = validate(schema, doc, o);
    if (errs.length) return { errors: errs };
  }
  let op: OperationNode;
  try {
    op = pickOperation(doc, o.operationName);
  } catch (e) {
    return { errors: [e as GraphQLError] };
  }
  const { vars, errors } = coerceVariables(schema, op, o.variables ?? {}, scalars);
  if (errors.length) return { errors };
  const ex = new Exec(schema, doc, op, o, scalars);
  ex.vars = vars;
  const rootName = op.operation === 'query' ? schema.query : op.operation === 'mutation' ? schema.mutation : schema.subscription;
  if (op.operation === 'subscription' || !rootName) return { errors: [new GraphQLError(op.operation === 'subscription' ? 'Subscriptions are not executed here.' : `Schema is not configured for ${op.operation}s.`)] };
  let data: Record<string, unknown> | null;
  try {
    data = await ex.executeObject(schema.types.get(rootName)!, o.rootValue ?? {}, op.selections, [], op.operation === 'mutation');
  } catch (e) {
    ex.errors.push(e instanceof GraphQLError ? e : new GraphQLError(String(e)));
    data = null;
  }
  return { data, ...(ex.errors.length ? { errors: ex.errors } : {}) };
}

/** The resolver calls a query would make, as a tree, without calling anything. Abstract fields list every possible type. */
export function plan(schema: Schema, doc: Document, o: { variables?: Variables; operationName?: string; scalars?: Readonly<Record<string, ScalarCoercion>> } = {}): PlanNode[] {
  const op = pickOperation(doc, o.operationName);
  const scalars = o.scalars ?? {};
  const { vars, errors } = coerceVariables(schema, op, o.variables ?? {}, scalars);
  if (errors.length) throw errors[0]!;
  const ex = new Exec(schema, doc, op, {}, scalars);
  ex.vars = vars;
  const build = (parent: TypeDef, sels: readonly SelectionNode[], path: readonly string[], cond: string | undefined): PlanNode[] => {
    const fields = new Map<string, FieldNode[]>();
    ex.collect(parent, sels, fields, new Set());
    const out: PlanNode[] = [];
    for (const [key, nodes] of fields) {
      const n = nodes[0]!;
      const def = ex.fieldDef(parent, n.name);
      if (!def) continue;
      const rt = schema.types.get(named(def.type))!;
      const subs = nodes.flatMap((x) => x.selections ?? []);
      let children: PlanNode[] = [];
      if (subs.length) {
        if (rt.kind === 'object') children = build(rt, subs, [...path, key], undefined);
        else for (const pn of schema.possibleTypes(rt.name)) children.push(...build(schema.types.get(pn)!, subs, [...path, key], pn));
      }
      out.push({ path: [...path, key], responseKey: key, parentType: parent.name, field: n.name, returnType: typeName(def.type), args: argValues(schema, def, n, vars, scalars), typeCondition: cond, children });
    }
    return out;
  };
  const rootName = op.operation === 'query' ? schema.query : op.operation === 'mutation' ? schema.mutation : schema.subscription;
  return build(schema.types.get(rootName!)!, op.selections, [], undefined);
}

// --- introspection ------------------------------------------------------------------------------------------------------

const KIND: Record<string, string> = { scalar: 'SCALAR', object: 'OBJECT', interface: 'INTERFACE', union: 'UNION', enum: 'ENUM', input: 'INPUT_OBJECT' };

function inputValueObj(schema: Schema, a: InputValueDef) {
  return { name: a.name, description: a.description ?? null, type: () => typeObj(schema, a.type), defaultValue: a.defaultValue ? printValue(a.defaultValue) : null, isDeprecated: a.deprecated !== undefined, deprecationReason: a.deprecated ?? null };
}

export function printValue(v: ValueNode): string {
  switch (v.kind) {
    case 'variable':
      return `$${v.name}`;
    case 'string':
      return JSON.stringify(v.value);
    case 'boolean':
      return String(v.value);
    case 'null':
      return 'null';
    case 'list':
      return `[${v.values.map(printValue).join(', ')}]`;
    case 'object':
      return `{${v.fields.map((f) => `${f.name}: ${printValue(f.value)}`).join(', ')}}`;
    default:
      return v.value;
  }
}

function typeObj(schema: Schema, t: TypeRef): Record<string, unknown> {
  if (t.kind === 'nonNull') return { kind: 'NON_NULL', name: null, ofType: () => typeObj(schema, t.of), description: null };
  if (t.kind === 'list') return { kind: 'LIST', name: null, ofType: () => typeObj(schema, t.of), description: null };
  const d = schema.types.get(t.name)!;
  const dep = (include: boolean, x: { deprecated: string | undefined }) => include || x.deprecated === undefined;
  return {
    kind: KIND[d.kind],
    name: d.name,
    description: d.description ?? null,
    specifiedByURL: d.specifiedBy ?? null,
    ofType: null,
    fields: (_s: unknown, a: { includeDeprecated?: boolean }) =>
      d.kind === 'object' || d.kind === 'interface'
        ? [...d.fields.values()].filter((f) => dep(!!a.includeDeprecated, f)).map((f) => ({ name: f.name, description: f.description ?? null, args: [...f.args.values()].map((x) => inputValueObj(schema, x)), type: () => typeObj(schema, f.type), isDeprecated: f.deprecated !== undefined, deprecationReason: f.deprecated ?? null }))
        : null,
    interfaces: () => (d.kind === 'object' || d.kind === 'interface' ? d.interfaces.map((i) => typeObj(schema, { kind: 'named', name: i })) : null),
    possibleTypes: () => (d.kind === 'interface' || d.kind === 'union' ? schema.possibleTypes(d.name).map((i) => typeObj(schema, { kind: 'named', name: i })) : null),
    enumValues: (_s: unknown, a: { includeDeprecated?: boolean }) => (d.kind === 'enum' ? [...d.values].filter(([, v]) => dep(!!a.includeDeprecated, v)).map(([n, v]) => ({ name: n, description: v.description ?? null, isDeprecated: v.deprecated !== undefined, deprecationReason: v.deprecated ?? null })) : null),
    inputFields: (_s: unknown, a: { includeDeprecated?: boolean }) => (d.kind === 'input' ? [...d.inputFields.values()].filter((f) => dep(!!a.includeDeprecated, f)).map((f) => inputValueObj(schema, f)) : null),
  };
}

function introspectionSchema(schema: Schema): Record<string, unknown> {
  const hidden = (n: string) => n.startsWith('__');
  return {
    description: null,
    types: () => [...schema.types.values()].filter((t) => !hidden(t.name)).map((t) => typeObj(schema, { kind: 'named', name: t.name })),
    queryType: () => typeObj(schema, { kind: 'named', name: schema.query }),
    mutationType: () => (schema.mutation ? typeObj(schema, { kind: 'named', name: schema.mutation }) : null),
    subscriptionType: () => (schema.subscription ? typeObj(schema, { kind: 'named', name: schema.subscription }) : null),
    directives: [...schema.directives.values()].map((d) => ({ name: d.name, description: d.description ?? null, locations: d.locations, args: [...d.args.values()].map((a) => inputValueObj(schema, a)), isRepeatable: d.repeatable })),
  };
}
