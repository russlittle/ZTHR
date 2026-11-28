# Proposal: the reference build's person-signed check fails closed

**For the owner to apply on `reference-implementation`.** That branch was read, not changed.

## The gap

`tools/person-signed.ts` passes by default in one case: when the commit the app serves predates the rule, it prints "it applies from the next deploy" and exits 0. Until a deploy lands, every commit, including one that loosens a locked journey card and rewrites `control/lock.json` to match, passes the check. It also treats any answer from GitHub other than 404 for the rule's file (a 403 rate limit, a 500) as "the rule is there", which is right only by luck.

## The change

When the served commit predates the rule, nothing passes by default: every commit since it must be verified and by a listed person, not only those touching protected paths. An unreadable answer fails.

```diff
--- a/tools/person-signed.ts
+++ b/tools/person-signed.ts
@@ export function unsigned(commits: CommitInfo[], people: Record<string, string>): string[] {
 }
 
+/** When the base predates the rule, nothing is passed by default: every commit must be a listed person's, verified. */
+export function unsignedAll(commits: CommitInfo[], people: Record<string, string>): string[] {
+  const logins = new Set(Object.values(people).map((l) => l.toLowerCase()));
+  return commits.flatMap((c) => {
+    const why = !c.login || !logins.has(c.login.toLowerCase()) ? `authored by ${c.login ?? 'no GitHub account'}, not a listed person` : !c.verified ? `not verified by GitHub (${c.reason})` : undefined;
+    return why ? [`${c.sha.slice(0, 7)} lands while the served commit predates this rule: ${why}`] : [];
+  });
+}
+
@@
   const atBase = await fetch(`${API}/contents/tools/person-signed.ts?ref=${base}`, { headers: { 'User-Agent': 'zthr-factory' } });
-  if (atBase.status === 404) {
-    console.log(`The commit the app serves (${base.slice(0, 7)}) predates this rule; it applies from the next deploy.`);
-    process.exit(0);
-  }
+  const predates = atBase.status === 404;
+  if (!predates && !atBase.ok) {
+    console.error(`GitHub answered ${atBase.status} for the rule at ${base.slice(0, 7)}; without an answer nothing passes.`);
+    process.exit(1);
+  }
+  if (predates) console.log(`The commit the app serves (${base.slice(0, 7)}) predates this rule, so nothing passes by default: every commit since it must be a listed person's, verified.`);
@@
-  const bad = unsigned(commits, people);
+  const bad = predates ? unsignedAll(commits, people) : unsigned(commits, people);
```

And in `tools/test/person-signed.test.ts`:

```ts
it('when the served commit predates the rule, nothing passes by default', () => {
  const agent = c({ login: 'claude-agent', verified: false, reason: 'unsigned', files: ['apps/advocate/src/x.ts'] });
  expect(unsignedAll([agent], people)).toEqual(['abcdef1 lands while the served commit predates this rule: authored by claude-agent, not a listed person']);
  expect(unsignedAll([c({ files: ['apps/advocate/src/x.ts'] })], people)).toEqual([]);
  expect(unsignedAll([c({})], {})).toHaveLength(1);
});
```

`tools/person-signed.ts` is a protected path, so the commit that makes this change must be your own, verified by GitHub.

The intent factory's own version of this rule, `intent/src/governance/goalposts.ts`, already behaves this way, and checks SSH signatures against your key locally instead of asking GitHub; its planted tests are in `intent/test/goalposts.test.ts`.
