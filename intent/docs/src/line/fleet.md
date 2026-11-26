# Fleet

> Everything in service, as one fleet: one library, one governance, and everything learned in service sent back to the start.

## TL;DR

Every app the line ships joins the fleet. They share a library, so a fix to a standard assembly reaches every app that uses it, proven by each app's own tests. Sensitive data is classified the same way in each ({{fleet.classes}}), gated and audited by the same rules. What people report and every alert come back as cases: a bug to the factory, an idea to the holder, and the line runs again.

{{diagram:fleet}}

## Explain it simply

Every shelf the company ever delivered is listed in one book, with the parts it used. When a school reports a bracket that wobbles, the fix is made to the standard bracket, and the book says exactly which other shelves have that bracket. Each gets the new bracket, and each is checked again before anyone says it is fixed.

## Engineer

### What the fleet page shows

- **In service.** Each app, its build, where it is served, and its journeys.
- **On the way.** Products not yet in service, with where each stands.
- **The library, where used.** Each standard assembly and the apps that use it, with its tests.
- **Sensitive data across the fleet.** Every field by class, by app, and whether it is gated.

### Connectors

Every app can reach the tools people already use, through {{connectors.count}} connectors of {{connectors.kinds}} kinds, each a stub with its configuration and secrets named, never stored:

{{table:connectors}}

### Housekeeping blocks

The fleet maintains the code most apps get wrong, as tested blocks every product starts from ({{blocks.tests}} tests between them):

{{table:blocks}}

## Architect

The fleet is where compounding pays out: every fix, part and rule made once applies everywhere it is used.

- **Where-used is the unit of maintenance.** A fix is made to the shared part, and the list of apps using it says what must re-prove itself, so no app is patched alone.
- **Governance is uniform.** One classification of sensitive data, one gate policy and one audit trail across every app; the central APIs can refuse a read anywhere on the same rule.
- **Service is the measure.** An app is in service when what is running is what passed, and it stays there while its service levels hold.
- **The loop closes here.** Reports and alerts become cases with defined routes back: a failing test first for a bug, a proposal to the holder for an idea, a Class II revision when the intent only needed clarifying.
