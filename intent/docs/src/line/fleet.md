# Fleet

> Everything in service, as one fleet: updated over the air with rollback, governed one way, and reporting back to mission control.

## TL;DR

Every app the line ships joins the fleet. Releases reach it over the air, in stages, with the previous revision kept ready so an update can be rolled back in one step. The fleet records which apps use each standard assembly from the library and which version each runs, so a fix made once can reach every app that uses it, proven by each app's own tests. Sensitive data is classified the same way in each ({{fleet.classes}}), gated and audited by the same rules. What people report and every alert go back to mission control: a bug goes to rework, an idea to the holder, and the plant runs again. Nothing is in service until a product has shipped; until then the fleet's lamp is off.

{{diagram:fleet}}

## Explain it simply

Every shelf the company ever delivered is listed in one book, with the parts it used. When a school reports a bracket that wobbles, the fix is made to the standard bracket, and the book says exactly which other shelves have that bracket. Each gets the new bracket, sent out to where it stands, and each is checked again before anyone says it is fixed. If a new bracket turns out worse, it is taken back in one step.

## Engineer

### What the fleet page shows

- **In service.** Each app, its build, where it is served, and its journeys.
- **On the way.** Products not yet in service, with where each stands.
- **Updates over the air.** How a release reaches an app, and the rollback path. Until a product is in service there are no updates to show, and the page says so.
- **The library, where used.** Each standard assembly and the apps that use it, with its tests.
- **Sensitive data across the fleet.** Every field by class, by app, and whether it is gated.

### Connectors

Every app can reach the tools people already use, through {{connectors.count}} connectors of {{connectors.kinds}} kinds, each a stub with its configuration and secrets named, never stored:

{{table:connectors}}

### Housekeeping blocks

[Product engineering](engineering.md) keeps the code most apps get wrong as tested blocks every product starts from ({{blocks.tests}} tests between them); the fleet shows where each is used:

{{table:blocks}}

{{diagram:library-tests}}

## Architect

The fleet is where compounding pays out: every fix, part and rule made once applies everywhere it is used.

- **Where-used is the unit of maintenance.** A fix is made to the shared part, and the list of apps using it says what must re-prove itself, so no app is patched alone.
- **Governance is uniform.** One classification of sensitive data, one gate policy and one audit trail across every app; the central APIs can refuse a read anywhere on the same rule.
- **Service is the measure.** An app is in service when what is running is what passed, and it stays there while its service levels hold.
- **Updates go out over the air.** A release reaches the field in stages with rollback, so a bad update is a step back, never an emergency.
- **The field reports back.** Reports and alerts go to mission control with defined routes onward: a failing test first for a bug, in rework; a proposal to the holder for an idea; a Class II revision when the intent only needed clarifying.
- **A lamp is lit only by something in service.** An empty fleet shows as off, never as passing.
