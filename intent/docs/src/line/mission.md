# Mission control

> Every product line and product, where each stands in every department, and what is waiting on a person.

## TL;DR

Mission control is where a program manager starts. It shows each product along the line, with a lamp for each department, and a short list of what only a person can do next: questions only the holder can answer, schematics ready to sign, packages ready to release. Every lamp is a link to that department with the product already in focus.

{{diagram:mission}}

## Explain it simply

It is the front office's whiteboard. Each order has a row; each department has a column; each cell says *done*, *waiting*, *stuck* or *not checked yet*. Next to the board is a short pile of things only the boss can sign. Nothing on the board is guessed: a cell that nobody has measured says *not measured*.

## Engineer

### What it shows

- **Waiting on you.** Built from what the browser knows: the product open in the studio, with its open questions, whether it is signed, and whether a revision is released; and every product kept in the library that is not yet released. The factory's own decisions for a person (Class I clarifications, production approvals, cases that stopped converging) are read with `intent agents proposals`.
- **Products along the line.** One row per product; one lamp per department from the intent studio to shipping, then the fleet. A product with several intents shows, at each department, the worst light any of them shows.
- **How the platform works.** Every intent's lamps, by department, and the measure: journeys walked as a person would, and passing.
- **Drill-down.** Platform, then product, then intent, then a journey's trail through every department.

{{diagram:waiting}}

### Lamps

| Lamp | Means |
| --- | --- |
| ✓ holds | Measured and holding |
| ✕ open or failing | Measured and failing, or open questions in the studio |
| ? not measured | Nothing has measured it; never shown as passing |
| … waiting | Waiting on an earlier department |

### Where the numbers come from

Two sources only: the factory's own feed, written by the build that measured it, and the studio's work kept in this browser. Nothing is inferred across departments.

## Architect

Mission control is a reader, never a writer: it holds no authority of its own. Its value is that every department reports in the same terms (a light per station, a headline, a measure), so one view can hold all of them without translation.

- **One shape for every report.** Each intent becomes a flow with the same five stations. New departments add a station rather than a new kind of view.
- **Worst light wins.** A product's lamp at a department is the worst any of its intents shows, so one failing intent is never averaged away.
- **Focus is shared, not copied.** The product in focus is one key in the browser that every page reads, so moving along the line never asks *which product?* again.
- **Waiting on a person is the only list that asks for action.** Everything else is evidence.
