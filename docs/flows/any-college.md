# Any college

Everything the Advocate knows about a college lives in one declared file in `control/colleges`: its name and the
words students use for it, its county, its website and its career office. Adding a college is one command; the
builder drafts the scouts its county needs, the factory admits them when their checks pass, and the journeys prove
students there are served, or told plainly what is not verified yet.

```mermaid
flowchart LR
  cmd[npm run add-college] --> file[control/colleges/new.yaml]
  cmd --> builder[Builder drafts a basic-needs scout for the county]
  builder --> checks{Declaration parses, source of record, journey card, falsification case}
  checks -- all pass --> certify[npm run certify: the factory admits it]
  certify --> scout[control/scouts/county-basic-needs.yaml]
  certify --> card[Journey card, locked]
  card --> journeys[Journeys: food, housing and utilities for a student there]
  file --> derived[County, website and career office everywhere they are used]
```

```mermaid
erDiagram
  COLLEGE ||--|| COUNTY : "is in"
  COUNTY ||--o{ SCOUT : "is covered by"
  SCOUT ||--o{ RESOURCE : "keeps fresh"
  COLLEGE ||--|| CAREER_OFFICE : has
  COLLEGE {
    string college "id"
    string name
    string short
    string[] words "how students say it"
    string county
    url website
  }
  SCOUT {
    string scout
    string[] needs
    url[] sources
    string[] entries
  }
```

A new county starts with a scout whose entries are empty. Until its sources are checked, a student there is offered
the statewide and national programs that serve them, and every other need is answered plainly and counted as a
gap, which is what the builder reads to decide what to draft next.

## Verified by

<!-- verified-by:start -->
- [`apps/advocate/test/colleges.test.ts`](../../apps/advocate/test/colleges.test.ts) (7 test definitions)
<!-- verified-by:end -->
