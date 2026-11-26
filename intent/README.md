# ZTHR Intent

Capture what people mean, read it back to them, and release it as the datum a factory builds to.

A person writes rough intent in their own words. Two independent readings by different model families, a design
lexicon and decision-table checks turn it into an intent frame: the end in mind, the problem, the people, the
outcomes, the measures and their tolerances, the rules. Every difference and gap becomes a redline the person
answers in a tap. The signed schematic is released as a package the factory consumes: journey gauges in the factory's
own card format, a control plan, working ranges and starting ratchets, pending tests, and a knowledge bundle.

```mermaid
flowchart LR
  W[Rough words] --> R[Two readings<br/>and rule checks]
  R --> Q[Redlines<br/>answered in a tap]
  Q --> D[The schematic<br/>signed]
  D --> P[Release package]
  P --> F[Factory]
  F --> M[Mission control:<br/>journeys walked and passing]
  M -. a failing journey .-> Q
```

## On zthr.ai

| Surface | What it is |
| --- | --- |
| [/intent](https://zthr.ai/intent) | The studio: from rough words to a released schematic, with the intent map, datum structure, inspection plan and release preview |
| [/factory](https://zthr.ai/factory) | The factory console: the latest build's readings, journeys, phases, gates and ratchets |
| [/mission](https://zthr.ai/mission) | Mission control: intents on the left, the factory on the right, working software the measure |

The deploy workflow builds all three from this folder (`npm run build`) after typecheck and tests pass. Nothing
built is committed. The factory console and mission control read `/reference/factory/factory.json`, which the
reference build writes from its own evidence.

## The release package

```mermaid
erDiagram
  RELEASE ||--|| DATUM : "datum.json"
  RELEASE ||--o{ GAUGE : "gauges/*.yaml"
  RELEASE ||--|| CONTROL_PLAN : "control-plan.yaml"
  RELEASE ||--|| RATCHETS : "ratchets.json"
  RELEASE ||--|| RANGES : "tolerances.json"
  RELEASE ||--o{ TEST : "tests/"
  RELEASE ||--o{ KNOWLEDGE : "knowledge/"
  RELEASE ||--|| MANIFEST : "manifest.json"
  RELEASE ||--|| BOM : "build-manifest.json"
  BOM ||--o{ PART : "from the library, or to make"
  PART }o--o{ STATEMENT : "builds"
  DATUM ||--o{ STATEMENT : "balloons"
  STATEMENT ||--o{ GAUGE : "walked by"
  STATEMENT ||--o| RATCHET : "floored by"
```

Before signing, the studio shows the build manifest: the bill of materials the factory starts from, each part marked from the library, extended, catalogued to make, or made new, and traced to the balloons that call for it. The release carries it exactly as previewed.

The same input always gives the same bytes; the browser and the command line produce the same package hash.

## Command line

```
node src/cli.ts readback intent.md --reading a.json --reading b.json
node src/cli.ts release  intent.md --rev 1 --to out/ --zip
node src/cli.ts init intent.md --workspace ws        # keep the work between sittings
```

## Develop

Node 22.18 or later.

```
npm ci
npm run verify     # types, tests, secret scan, and a build of all three surfaces
npm run build      # writes docs/intent, docs/factory, docs/mission, behind Google sign-in by invitation
npm run build -- --open   # the same, with no sign-in, for local checks or your own copy
```

- [The release package, file by file](docs/formats.md)
- [Connectors to the tools teams already use](docs/connectors.md)
- [Who can use the tools on zthr.ai, and how to invite people](docs/access.md)

Apache 2.0.
