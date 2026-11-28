import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONDITION_OPERATORS, PolicyError, evaluate, evaluateMany, ipInCidr, validatePolicy, wildcardMatch } from './index.ts';
import type { Policy, Request, Statement } from './index.ts';

const allow = (s: Partial<Statement> & Pick<Statement, 'Action'>): Policy => ({ Version: '2012-10-17', Statement: { Effect: 'Allow', Resource: '*', ...s } });
const deny = (s: Partial<Statement> & Pick<Statement, 'Action'>): Policy => ({ Version: '2012-10-17', Statement: { Effect: 'Deny', Resource: '*', ...s } });
const ok = (policies: Policy[], req: Request, boundaries?: Policy[][]) => evaluate({ policies, ...(boundaries ? { boundaries } : {}) }, req).allowed;
const get = (resource: string, context: Request['context'] = {}): Request => ({ action: 's3:GetObject', resource, context });

test('everything is denied until a statement allows it, and the reason says so', () => {
  const d = evaluate({ policies: [] }, get('arn:aws:s3:::b/k'));
  assert.equal(d.allowed, false);
  assert.equal(d.reason, 'implicit-deny');
  assert.match(d.explanation, /no statement allows s3:GetObject on arn:aws:s3:::b\/k/);
  const other = evaluate({ policies: [allow({ Action: 's3:PutObject' })] }, get('arn:aws:s3:::b/k'));
  assert.equal(other.reason, 'implicit-deny');
  assert.equal(other.trace[0]!.why, 'action did not match');
});

test('an allow matches by wildcard action and resource; actions ignore case, resources do not', () => {
  const p = allow({ Action: ['s3:Get*', 'ec2:Describe?nstances'], Resource: 'arn:aws:s3:::reports/*' });
  assert.equal(ok([p], get('arn:aws:s3:::reports/2024/q1.csv')), true);
  assert.equal(ok([p], { action: 'S3:getobject', resource: 'arn:aws:s3:::reports/x' }), true, 'service and action names are case-insensitive');
  assert.equal(ok([p], get('arn:aws:s3:::Reports/x')), false, 'resources are case-sensitive');
  assert.equal(ok([p], get('arn:aws:s3:::other/x')), false);
  assert.equal(ok([p], { action: 'ec2:DescribeInstances', resource: 'arn:aws:s3:::reports/x' }), true, '? matches one character');
  assert.equal(ok([allow({ Action: '*' })], get('anything')), true);
});

test('an explicit deny beats any allow, in any policy, and in a boundary', () => {
  const a = allow({ Action: 's3:*' });
  const d = deny({ Action: 's3:GetObject', Resource: 'arn:aws:s3:::secret/*', Sid: 'NoSecrets' });
  const r = evaluate({ policies: [a, d] }, get('arn:aws:s3:::secret/key'));
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'explicit-deny');
  assert.match(r.explanation, /policy\[1\] statement 0 \(NoSecrets\) explicitly denies/);
  assert.equal(r.matched.length, 1);
  assert.equal(ok([a, d], get('arn:aws:s3:::public/key')), true);
  assert.equal(ok([a], get('arn:aws:s3:::secret/key'), [[a, d]]), false, 'a deny in a boundary also wins');
});

test('NotAction and NotResource allow everything except what they name', () => {
  const p = allow({ NotAction: 'iam:*', Resource: undefined, NotResource: 'arn:aws:s3:::vault/*' } as never);
  assert.equal(ok([p], { action: 's3:GetObject', resource: 'arn:aws:s3:::pub/x' }), true);
  assert.equal(ok([p], { action: 'iam:CreateUser', resource: 'arn:aws:s3:::pub/x' }), false);
  assert.equal(ok([p], get('arn:aws:s3:::vault/x')), false);
  assert.equal(evaluate({ policies: [p] }, { action: 'iam:CreateUser', resource: 'r' }).trace[0]!.why, 'action is excluded by NotAction');
  const nd = deny({ NotAction: ['s3:Get*'] });
  assert.equal(ok([allow({ Action: '*' }), nd], get('x')), true, 'the deny does not apply to the one action it exempts');
  assert.equal(ok([allow({ Action: '*' }), nd], { action: 's3:PutObject', resource: 'x' }), false);
});

test('policy variables: each person gets only their own folder, and a hostile value cannot become a wildcard', () => {
  const home = allow({ Action: 's3:*', Resource: 'arn:aws:s3:::company/home/${aws:username}/*' });
  const as = (user: string, key: string) => ok([home], get(`arn:aws:s3:::company/home/${key}`, { 'aws:username': user }));
  assert.equal(as('alice', 'alice/notes.txt'), true);
  assert.equal(as('alice', 'bob/notes.txt'), false);
  assert.equal(as('*', 'bob/notes.txt'), false, 'a username of "*" is literal text');
  assert.equal(as('al*', 'alice/notes.txt'), false);
  assert.equal(as('?lice', 'alice/notes.txt'), false);
  assert.equal(as('*', '*/notes.txt'), true, 'it matches only a folder literally named *');
  assert.equal(ok([home], get('arn:aws:s3:::company/home/alice/x')), false, 'with no username in the request the statement cannot match');
  const dflt = allow({ Action: 's3:*', Resource: "arn:aws:s3:::b/${aws:username, 'guest'}/*" });
  assert.equal(ok([dflt], get('arn:aws:s3:::b/guest/x')), true, 'a default covers a missing key');
});

test('escapes: ${*}, ${?} and ${$} are literal characters', () => {
  const p = allow({ Action: 's3:*', Resource: 'arn:aws:s3:::b/${*}/${?}/${$}x' });
  assert.equal(ok([p], get('arn:aws:s3:::b/*/?/$x')), true);
  assert.equal(ok([p], get('arn:aws:s3:::b/a/b/$x')), false);
  assert.throws(() => ok([allow({ Action: 's3:*', Resource: 'arn:aws:s3:::b/${oops' })], get('arn:aws:s3:::b/x')), /unclosed/);
});

test('string conditions: several values are ORed, negated operators AND, missing keys follow AWS', () => {
  const eq = allow({ Action: 's3:*', Condition: { StringEquals: { 'aws:PrincipalTag/dept': ['eng', 'ops'] } } });
  assert.equal(ok([eq], get('r', { 'aws:PrincipalTag/dept': 'ops' })), true);
  assert.equal(ok([eq], get('r', { 'aws:PrincipalTag/dept': 'sales' })), false);
  assert.equal(ok([eq], get('r', { 'AWS:principaltag/DEPT': 'eng' })), true, 'condition key names are case-insensitive');
  assert.equal(ok([eq], get('r')), false, 'a missing key fails a positive operator');
  const ne = allow({ Action: 's3:*', Condition: { StringNotEquals: { 'aws:username': ['root', 'admin'] } } });
  assert.equal(ok([ne], get('r', { 'aws:username': 'alice' })), true);
  assert.equal(ok([ne], get('r', { 'aws:username': 'admin' })), false, 'must differ from every listed value');
  assert.equal(ok([ne], get('r')), true, 'a missing key satisfies a negated operator');
  const like = allow({ Action: 's3:ListBucket', Condition: { StringLike: { 's3:prefix': ['home/*', 'public/??.txt'] } } });
  const ls = (prefix: string) => ok([like], { action: 's3:ListBucket', resource: 'arn:aws:s3:::b', context: { 's3:prefix': prefix } });
  assert.equal(ls('home/alice/'), true);
  assert.equal(ls('public/ab.txt'), true);
  assert.equal(ls('public/abc.txt'), false);
  assert.equal(ls('Home/x'), false);
  const ic = allow({ Action: '*', Condition: { StringEqualsIgnoreCase: { 'aws:RequestTag/env': 'Prod' } } });
  assert.equal(ok([ic], get('r', { 'aws:RequestTag/env': 'PROD' })), true);
});

test('numeric, date and bool conditions, including epoch seconds and ISO dates', () => {
  const n = allow({ Action: '*', Condition: { NumericLessThanEquals: { 's3:max-keys': '100' }, NumericGreaterThan: { 's3:max-keys': 0 } } });
  assert.equal(ok([n], get('r', { 's3:max-keys': 100 })), true);
  assert.equal(ok([n], get('r', { 's3:max-keys': 101 })), false);
  assert.equal(ok([n], get('r', { 's3:max-keys': 0 })), false);
  assert.equal(ok([n], get('r', { 's3:max-keys': 'many' })), false, 'a non-number never satisfies a numeric operator');
  const window = allow({ Action: '*', Condition: { DateGreaterThan: { 'aws:CurrentTime': '2024-01-01T00:00:00Z' }, DateLessThan: { 'aws:CurrentTime': '2024-12-31T23:59:59Z' } } });
  assert.equal(ok([window], get('r', { 'aws:CurrentTime': '2024-06-15T12:00:00Z' })), true);
  assert.equal(ok([window], get('r', { 'aws:CurrentTime': String(Date.UTC(2024, 5, 15) / 1000) })), true, 'epoch seconds work');
  assert.equal(ok([window], get('r', { 'aws:CurrentTime': '2025-01-01T00:00:00Z' })), false);
  assert.equal(ok([window], get('r', { 'aws:CurrentTime': 'not a date' })), false);
  const tls = deny({ Action: 's3:*', Condition: { Bool: { 'aws:SecureTransport': 'false' } } });
  const base = allow({ Action: 's3:*' });
  assert.equal(ok([base, tls], get('r', { 'aws:SecureTransport': false })), false);
  assert.equal(ok([base, tls], get('r', { 'aws:SecureTransport': true })), true);
  assert.equal(ok([base, tls], get('r')), true, 'no key, no match for a Bool, so the deny does not apply');
});

test('IP conditions: IPv4 and IPv6 blocks, bare addresses, negation, and malformed input', () => {
  assert.equal(ipInCidr('203.0.113.50', '203.0.113.0/24'), true);
  assert.equal(ipInCidr('203.0.114.1', '203.0.113.0/24'), false);
  assert.equal(ipInCidr('10.0.0.1', '10.0.0.1'), true);
  assert.equal(ipInCidr('10.0.0.2', '10.0.0.1/32'), false);
  assert.equal(ipInCidr('1.2.3.4', '0.0.0.0/0'), true);
  assert.equal(ipInCidr('2001:db8:1234:5678::1', '2001:DB8:1234:5678::/64'), true);
  assert.equal(ipInCidr('2001:db8:1234:5679::1', '2001:db8:1234:5678::/64'), false);
  assert.equal(ipInCidr('::1', '::/0'), true);
  assert.equal(ipInCidr('1.2.3.4', '::/0'), false, 'families do not mix');
  assert.equal(ipInCidr('::ffff:1.2.3.4', '::ffff:0:0/96'), true);
  for (const bad of ['1.2.3.4/33', '1.2.3/24', '999.1.1.1/8', 'x/8', '1.2.3.4/', '1.2.3.4/-1']) assert.equal(ipInCidr('1.2.3.4', bad), false, bad);
  const office = allow({ Action: '*', Condition: { IpAddress: { 'aws:SourceIp': ['203.0.113.0/24', '2001:db8::/32'] } } });
  assert.equal(ok([office], get('r', { 'aws:SourceIp': '203.0.113.9' })), true);
  assert.equal(ok([office], get('r', { 'aws:SourceIp': '2001:db8:0:1::5' })), true);
  assert.equal(ok([office], get('r', { 'aws:SourceIp': '198.51.100.1' })), false);
  const block = deny({ Action: '*', Condition: { NotIpAddress: { 'aws:SourceIp': '203.0.113.0/24' } } });
  assert.equal(ok([allow({ Action: '*' }), block], get('r', { 'aws:SourceIp': '198.51.100.1' })), false);
  assert.equal(ok([allow({ Action: '*' }), block], get('r', { 'aws:SourceIp': '203.0.113.5' })), true);
});

test('set operators: ForAnyValue, ForAllValues, and a many-valued key without either never matches', () => {
  const tags = ['red', 'blue'];
  const any = allow({ Action: '*', Condition: { 'ForAnyValue:StringEquals': { 'aws:TagKeys': ['blue', 'green'] } } });
  const all = allow({ Action: '*', Condition: { 'ForAllValues:StringEquals': { 'aws:TagKeys': ['red', 'blue', 'green'] } } });
  const plain = allow({ Action: '*', Condition: { StringEquals: { 'aws:TagKeys': ['red', 'blue'] } } });
  assert.equal(ok([any], get('r', { 'aws:TagKeys': tags })), true);
  assert.equal(ok([any], get('r', { 'aws:TagKeys': ['red'] })), false);
  assert.equal(ok([any], get('r')), false, 'ForAnyValue needs the key');
  assert.equal(ok([all], get('r', { 'aws:TagKeys': tags })), true);
  assert.equal(ok([all], get('r', { 'aws:TagKeys': ['red', 'purple'] })), false);
  assert.equal(ok([all], get('r')), true, 'ForAllValues holds when the key is absent');
  assert.equal(ok([plain], get('r', { 'aws:TagKeys': tags })), false);
  assert.equal(ok([plain], get('r', { 'aws:TagKeys': 'red' })), true);
});

test('IfExists, Null and ARN conditions', () => {
  const ife = allow({ Action: '*', Condition: { StringEqualsIfExists: { 'aws:RequestTag/env': 'prod' } } });
  assert.equal(ok([ife], get('r')), true, 'absent is fine');
  assert.equal(ok([ife], get('r', { 'aws:RequestTag/env': 'dev' })), false, 'present must match');
  const nul = deny({ Action: '*', Condition: { Null: { 'aws:MultiFactorAuthAge': 'true' } } });
  const a = allow({ Action: '*' });
  assert.equal(ok([a, nul], get('r')), false);
  assert.equal(ok([a, nul], get('r', { 'aws:MultiFactorAuthAge': 300 })), true);
  const arn = allow({ Action: '*', Condition: { ArnLike: { 'aws:PrincipalArn': 'arn:aws:iam::123456789012:role/dev-*' } } });
  assert.equal(ok([arn], get('r', { 'aws:PrincipalArn': 'arn:aws:iam::123456789012:role/dev-alice' })), true);
  assert.equal(ok([arn], get('r', { 'aws:PrincipalArn': 'arn:aws:iam::999999999999:role/dev-alice' })), false);
  assert.equal(ok([arn], get('r', { 'aws:PrincipalArn': 'arn:aws:iam::123456789012:user/dev-alice' })), false);
  assert.equal(ok([arn], get('r', { 'aws:PrincipalArn': 'not-an-arn' })), false);
  const narn = deny({ Action: '*', Condition: { ArnNotLike: { 'aws:PrincipalArn': 'arn:aws:iam::123456789012:*' } } });
  assert.equal(ok([a, narn], get('r', { 'aws:PrincipalArn': 'arn:aws:iam::123456789012:role/x' })), true);
  assert.equal(ok([a, narn], get('r', { 'aws:PrincipalArn': 'arn:aws:iam::222222222222:role/x' })), false);
});

test('principals in resource policies: "*", ARNs, bare account ids, and NotPrincipal', () => {
  const rp = (s: Partial<Statement>): Policy => ({ Statement: { Effect: 'Allow', Action: 's3:GetObject', Resource: '*', ...s } });
  const who = 'arn:aws:iam::123456789012:user/alice';
  const call = (p: Policy, principal?: Request['principal']) => ok([p], { action: 's3:GetObject', resource: 'r', ...(principal ? { principal } : {}) });
  assert.equal(call(rp({ Principal: '*' }), who), true);
  assert.equal(call(rp({ Principal: { AWS: [who] } }), who), true);
  assert.equal(call(rp({ Principal: { AWS: '123456789012' } }), who), true);
  assert.equal(call(rp({ Principal: { AWS: '999999999999' } }), who), false);
  assert.equal(call(rp({ Principal: { AWS: [who] } }), { AWS: 'arn:aws:iam::123456789012:user/bob' }), false);
  assert.equal(call(rp({ Principal: { AWS: [who] } })), false, 'no caller, no match');
  assert.equal(call(rp({ NotPrincipal: { AWS: [who] } }), who), false);
  assert.equal(call(rp({ NotPrincipal: { AWS: [who] } }), 'arn:aws:iam::123456789012:user/bob'), true);
});

test('boundaries: the request must also be allowed by every boundary set, and the decision says which fell short', () => {
  const wide = allow({ Action: '*' });
  const s3only = allow({ Action: 's3:*' });
  const logsOnly = allow({ Action: 'logs:*' });
  const req: Request = { action: 's3:GetObject', resource: 'r' };
  assert.equal(ok([wide], req, [[s3only]]), true);
  const short = evaluate({ policies: [wide], boundaries: [[s3only], [logsOnly]] }, req);
  assert.equal(short.allowed, false);
  assert.equal(short.reason, 'boundary-no-allow');
  assert.match(short.explanation, /boundary set 1 does not/);
  assert.equal(ok([], req, [[wide]]), false, 'a boundary never grants by itself');
});

test('the trace says, per statement, why it did or did not apply', () => {
  const p: Policy = { Statement: [
    { Sid: 'A', Effect: 'Allow', Action: 's3:Put*', Resource: '*' },
    { Sid: 'B', Effect: 'Allow', Action: 's3:Get*', Resource: 'arn:aws:s3:::other/*' },
    { Sid: 'C', Effect: 'Allow', Action: 's3:Get*', Resource: '*', Condition: { StringEquals: { 'aws:username': 'carol' } } },
    { Sid: 'D', Effect: 'Allow', Action: 's3:Get*', Resource: '*', Condition: { StringEquals: { 'aws:username': ['alice', 'bob'] } } },
  ] };
  const d = evaluate({ policies: [p] }, get('arn:aws:s3:::mine/k', { 'aws:username': 'dave' }));
  assert.deepEqual(d.trace.map((t) => [t.sid, t.matched, t.why]), [
    ['A', false, 'action did not match'],
    ['B', false, 'resource did not match'],
    ['C', false, 'condition StringEquals aws:username failed: request value "dave" against ["carol"]'],
    ['D', false, 'condition StringEquals aws:username failed: request value "dave" against ["alice","bob"]'],
  ]);
  assert.equal(evaluate({ policies: [p] }, get('arn:aws:s3:::mine/k', { 'aws:username': 'bob' })).explanation, 'allowed by policy[0] statement 3 (D)');
});

test('wildcards are matched in linear time, so a hostile pattern cannot stall evaluation', () => {
  const started = Date.now();
  assert.equal(wildcardMatch('*a*a*a*a*a*a*a*a*a*a*b', 'a'.repeat(20_000)), false);
  assert.equal(wildcardMatch('*a*a*a*a*a*a*a*a*a*a*a', 'a'.repeat(20_000)), true);
  assert.ok(Date.now() - started < 2000, 'finished quickly');
  assert.equal(wildcardMatch('a*b?c', 'aXXbYc'), true);
  assert.equal(wildcardMatch('a*b?c', 'aXXbc'), false);
  assert.equal(wildcardMatch('', ''), true);
  assert.equal(wildcardMatch('*', ''), true);
  assert.equal(wildcardMatch('?', ''), false);
  assert.throws(() => wildcardMatch('x'.repeat(3000), 'x'), /at most 2048/);
});

test('requests are checked: one concrete action, a resource, no wildcards or control characters', () => {
  assert.throws(() => evaluate({ policies: [] }, { action: 's3:*', resource: 'r' }), PolicyError);
  assert.throws(() => evaluate({ policies: [] }, { action: 'GetObject', resource: 'r' }), /not an action/);
  assert.throws(() => evaluate({ policies: [] }, { action: 's3:GetObject', resource: '' }), /needs a resource/);
  assert.throws(() => evaluate({ policies: [allow({ Action: '*', Condition: { Wibble: { a: 'b' } } })] }, get('r')), /not a condition operator/);
  const many = evaluateMany({ policies: [allow({ Action: ['s3:Get*', 's3:List*'] })] }, ['s3:GetObject', 's3:PutObject', 's3:ListBucket'], 'r');
  assert.deepEqual(Object.fromEntries(Object.entries(many).map(([k, v]) => [k, v.allowed])), { 's3:GetObject': true, 's3:PutObject': false, 's3:ListBucket': true });
  assert.ok(CONDITION_OPERATORS.includes('StringLike') && CONDITION_OPERATORS.includes('IpAddress') && CONDITION_OPERATORS.includes('ArnNotLike'));
});

test('validation: a sound policy passes; each kind of mistake is named', () => {
  const good = { Version: '2012-10-17', Statement: [{ Sid: 'Read', Effect: 'Allow', Action: ['s3:Get*', 'logs:*'], Resource: ['arn:aws:s3:::b/*', '*'], Condition: { IpAddress: { 'aws:SourceIp': '10.0.0.0/8' } } }] };
  assert.deepEqual(validatePolicy(good), []);
  assert.deepEqual(validatePolicy({ Statement: { Effect: 'Allow', Action: '*', Resource: '*' } }), []);
  const bad = { Version: '2020-01-01', Statement: [
    { Effect: 'Permit', Action: 'nope', Resource: 'bucket' },
    { Sid: 'x y', Effect: 'Allow', Action: 's3:Get', NotAction: 's3:Put', Resource: '*' },
    { Sid: 'Dup', Effect: 'Allow', Action: 's3:Get' },
    { Sid: 'Dup', Effect: 'Allow', Action: 's3:Get', Resource: '*', Principal: '*', Condition: { Wobble: { a: 'b' }, IpAddress: { 'aws:SourceIp': 'not-ip' } } },
    { Effect: 'Allow', Action: 's3:Get', Resource: 'arn:aws:s3:::b/${aws:username' },
  ] };
  const problems = validatePolicy(bad);
  for (const re of [/Version "2020-01-01"/, /Effect must be/, /Action "nope"/, /Resource "bucket" is not/, /Sid "x y"/, /exactly one of Action and NotAction/, /Resource or NotResource is required/, /Sid "Dup" is used twice/, /no Principal/, /"Wobble" is not a condition operator/, /"not-ip" is not an address/, /unclosed variable/]) assert.ok(problems.some((p) => re.test(p)), `missing ${re}: ${problems.join(' | ')}`);
  assert.deepEqual(validatePolicy('x'), ['a policy is a JSON object']);
  assert.match(validatePolicy({ Statement: [] })[0]!, /Statement is required/);
  assert.match(validatePolicy({ Statement: { Effect: 'Allow', Action: '*', Resource: '*' } }, { maxChars: 10 })[0]!, /limit is 10/);
  assert.match(validatePolicy({ Statement: { Effect: 'Allow', Action: '*' } }, { kind: 'resource' })[0]!, /Principal or NotPrincipal is required/);
});
