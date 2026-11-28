# The line, walked by the people who use it

zthr.ai's tools are the areas of one plant, grouped as the plant model groups them: the front office, engineering, the line, the field and support. Eight people walk it below, each with their own job to get done. A script walks every step in a real browser, and checks each page against WCAG 2.2 A and AA. The plant itself is drawn on [the plant page](/plant/) and in [the line docs](line/README.md).

| Area | What it is for | What carries forward |
| --- | --- | --- |
| Mission control | Runs the plant: priorities, approvals, stop-the-line and spend, and where every product stands | The product in focus |
| Product lines | Who a line serves, its end in mind, its compliance, sign-in and other spec-sheet defaults (inside Mission control) | The defaults, into every product started in the line |
| Intent studio | The words, the questions only the expert can settle, the review, and the signature (inside Product lines) | The signed intent package |
| Product engineering | The complete specification (outcomes, information, compliance, operations, measures and tests, spec sheet and manifest) with a checklist | The product spec |
| Manufacturing engineering | The build package: routing, gates, required checks and process capability; it also improves the line | The build package |
| Factory floor | What the factory built and measured | The build |
| QA | Journeys walked as a person would, gates proven able to fail, ratchets | The certified phases; failed product, to rework |
| Rework | Failed product, fixed and sent back through QA | Fixed product, to QA |
| Shipping | Packages code, tests, docs and version history into a signed release, publishes it, and deploys it with a person approving | The signed release |
| Fleet | Products in service, updated over the air with rollback | Reports and alerts, back to Mission control |
| Maintenance | Keeps the factory floor running: what every area tagged, the morning report, the crew's cost and pass rates | The morning report, back to Mission control |
| Metrology | Serves QA: the measures and their references, gauge certificates, control charts, and the claims audit | Certified gauges, to QA |
| Deployment engineering | Serves shipping and the fleet: environments as code, deploy pipelines, monitoring | Environments and pipelines |

Every page carries the same bar: the areas by group, the line numbered in order, the front office and support unnumbered, the product in focus, and a lamp for where that product stands in each area. Pages on the line end with one handoff to the next area. The handoff is filled in only when the work there is ready to go on.

## Who walked it

| Persona | Job | Path |
| --- | --- | --- |
| Dana, program director | See what needs her, and whether anything shipped is hurting | Mission control, then Fleet |
| Marcus, product-line owner | Set up a line once, so every product in it starts right | Product lines |
| Rosa, director of student success | Say what Bill help must do, and sign it | Product lines, then the intent studio |
| Priya, engineer | Make the specification complete, and release it | Engineering |
| Ken, factory operator | See what is being built for which product | Factory |
| Alma, QA lead | See what was walked and what holds | QA |
| Lee, release manager | See how a product will ship, and what holds it in service | Shipping |
| Jo, low-vision keyboard user | All of the above, by keyboard, zoomed, on a phone | Every page |

## Grades

Seven axes, A to F:
- **Find:** they reach the area.
- **Grasp:** they know what it is for within ten seconds.
- **Act:** the next action is obvious.
- **Carry:** the product in focus and its choices come with them.
- **Truth:** every number is sourced, or shown as not measured.
- **Access:** keyboard, screen reader and narrow screens all work.
- **Delight:** the density and the craft.

Grades are given for the tools as they were (three surfaces joined by a bar), and after joining the line and fixing what the first walk found.

| Persona | Find | Grasp | Act | Carry | Truth | Access | Delight | Overall |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Dana, before | B | C | D | D | A | A | B | C |
| Dana, after | A | A | A- | A- | A | A | B+ | A- |
| Marcus, before | F | F | F | F | n/a | n/a | n/a | F |
| Marcus, after | A | A | A | A | A | A | B+ | A |
| Rosa, before | A | A- | B | C | A | A | B+ | B |
| Rosa, after | A | A | A | A | A | A | B+ | A |
| Priya, before | C | C | C | B | A | A | B | C+ |
| Priya, after | A | A | A | A | A | A | A- | A |
| Ken, before | B | B | C | D | B | A | B | C+ |
| Ken, after | A | A | B+ | A- | A | A | B | A- |
| Alma, before | C | B | C | D | A | A | B | C+ |
| Alma, after | A | A | A- | A- | A | A | B | A- |
| Lee, before | F | F | F | F | n/a | n/a | n/a | F |
| Lee, after | A | A | B | A- | A | A | B | B+ |
| Jo, before | B | B | B | C | A | A- | B | B |
| Jo, after | A | A | A- | A | A | A | B | A- |

## What is still open

- **Shipping stage results.** The reference factory's feed does not yet carry a result for each delivery stage, so shipping shows each stage as not measured. The feed needs a `delivery` block written by the pipeline's own `stage_record` calls.
- **The factory's own decisions.** Mission control's list of what is waiting on a person shows only what the browser knows. The factory's proposals (clarifications it may not make, production approvals, cases that stopped converging) are read with `intent agents proposals` until the ledger publishes them into the feed.
- **Agreement among raters.** The persona grades are one rater's. A second family grading the same walk would show whether the grades agree.
