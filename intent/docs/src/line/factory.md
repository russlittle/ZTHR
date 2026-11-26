# Factory

> Build to the released package, and measure what was built. Nothing red is pushed, and nothing is admitted on anyone's word.

## TL;DR

Agents build to the released package, each in a role defined by what it is denied. A builder runs the existing tests on the base and then on its own commit before anything is pushed. The factory's API runs every required check itself and records what the process returned. Two reviewers from model families other than the author's must pass the change. Admission is computed from that record; nobody can set it. Every failure opens a case, and most cases are corrected without asking anyone.

{{diagram:factory}}

## Explain it simply

The shop floor builds to the released drawing. Before a part leaves a bench, the worker checks it against the drawing, and checks the bench itself is true first. Then the part goes through gauges the worker does not control, and two inspectors from different shops look at it. If any of that fails, it goes back with a ticket saying what failed. Most tickets are a mistake to fix. A few say the drawing is unclear, and those go back to the drafting office.

## Engineer

### Roles

{{table:roles}}

Every call to the API is logged in a hash chain. A refusal says why and what to do instead.

### Before a push

`change_open` runs typecheck and tests on the base first: a test already failing there becomes its own case against the base, and the new work waits on a green base. Then it runs them on the commit; a red commit is refused. The paths a commit touches are read from git, not from the builder's list, so a locked path cannot be left off. A pre-push hook refuses any commit the API has not seen pass.

### Required checks

{{table:checks}}

Checks run cheapest first, stop at the first failure, and are not run again on an identical tree. A model reviews a change only after every check has passed.

### Correction without asking

A failure opens a case. The builder diagnoses it: a **bug** (the work misses a clear datum) is fixed, test first, with nobody asked. **Intent**, **infeasible** or **factory** must name the balloons and be confirmed by a reviewer of another family. A confirmed intent case is clarified with examples and notes; the API compares the draft with the signed revision, and a Class II clarification is issued by the factory under the holder's delegation. A case goes to a person when the intent cannot be met, a change would be Class I, three attempts in a row fail no better, or it passes its spending ceiling.

### Cost

The fixture judges the work, not the model, so each seat runs the cheapest model that can do its job, and every token is metered against a ceiling that pauses the agenda when it is reached.

{{table:models}}

## Architect

The factory is where Symmetric Zero Trust is enforced: no participant gains authority by asserting success.

- **Results are measured, not reported.** The API runs checks and records exit codes; the pipeline records stage results; admission is computed. An agent can read every result and write none.
- **Independence is structural.** Readers never see each other's readings; reviewers are of other families than the author; {{review.families}} families touch every change.
- **Authority by absence.** The {{agents.personOnly}} acts only a person takes have no tool. Locked, person-only and generated paths are refused at `change_open` from the commit's real diff.
- **The cheap path is the default.** Machines before models; cheapest check first; content-addressed reuse; one review family at a time; an empty agenda wakes nobody.
- **Every miss becomes a fixture.** A bug becomes a failing test and a ratchet; a clarification becomes a revision; a new capability becomes a part or a block for the next product.

See [the factory, run by agents](../agents.md) and the [tool reference](../agents-tools.md).
