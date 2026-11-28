# Mission control

> The front office: it runs the plant. It sets priorities, gives approvals, stops the line when it must and holds the spend, and it sees every product line and product, where each stands in every area, and what waits on a person.

## TL;DR

Mission control is the front office, and it runs the plant. It decides what is worked on next, holds the acts only a person may do (questions only the holder can answer, intent packages ready to sign, releases ready to approve), can stop the line when a required check goes red, and holds the spend of every crew. To do that it sees each product along the line, with a lamp for each area, and every lamp is a link to that area with the product already in focus. The product lines and their intent studios sit inside it.

{{diagram:mission}}

## Explain it simply

It is the front office's whiteboard, and the boss's desk. Each order has a row; each area has a column; each cell says *done*, *waiting*, *stuck* or *not checked yet*. Next to the board is a short pile of things only the boss can sign. The boss can also pull the cord that stops the line, and decides how much each crew may spend. Nothing on the board is guessed: a cell that nobody has measured says *not measured*.

## Engineer

### What it does

| It | By |
| --- | --- |
| Sets priorities | Choosing which product line and product the plant works on next; every area works to it |
| Gives approvals | Holding the acts no agent has a tool for: signing an intent, approving production, resetting a ratchet |
| Stops the line | A red required check stops new work on its branch until the fix names it (`tools/stop-line.ts`, `src/governance/stopline.ts`) |
| Holds the spend | A budget per crew and per product; the crews' costs are on [maintenance](maintenance.md) |

### What it shows

- **Waiting on you.** Built from what the browser knows: the product open in the studio, with its open questions, whether it is signed, and whether a revision is released; and every product kept in the library that is not yet released. The factory's own decisions for a person (Class I clarifications, production approvals, returns that stopped converging) are read with `intent agents proposals`.
- **Products along the line.** One row per product; one lamp per area from the intent studio to the fleet, with rework between QA and shipping. A product with several intents shows, at each area, the worst light any of them shows.
- **How the plant works.** Every intent's lamps, by area, and the measure: journeys walked as a person would, and passing.
- **The fleet, metrology, maintenance and deployment engineering.** The fleet, for what is in service; metrology, for which gauges are certified; maintenance, for the night shift's morning report; deployment engineering, for where products run.
- **Drill-down.** Platform, then product, then intent, then a journey's trail through every area.
- **What it needs.** Its page ends with the model's list of what mission control needs and which needs the repository shows met, among them a live feed from every area, a spend budget per crew and per product, and the stop-the-line authority.

{{diagram:waiting}}

### Lamps

| Lamp | Means |
| --- | --- |
| ✓ holds | Measured and holding |
| ✕ open or failing | Measured and failing, or open questions in the studio |
| ? not measured | Nothing has measured it; never shown as passing |
| … waiting | Waiting on an earlier area |

### Where the numbers come from

Two sources only: the factory's own feed, written by the build that measured it, and the studio's work kept in this browser. Nothing is inferred across areas.

## Architect

Mission control holds the plant's authority, and its readings are never inferred. Priorities, approvals, stop-the-line and spend are its to give; what it reads from every area is only what that area measured.

- **One shape for every report.** Each intent becomes a flow with the same stations, one for each area that reports. A new area adds a station rather than a new kind of view.
- **Worst light wins.** A product's lamp at an area is the worst any of its intents shows, so one failing intent is never averaged away.
- **Focus is shared, not copied.** The product in focus is one key in the browser that every page reads, so moving along the line never asks *which product?* again.
- **Waiting on a person is the only list that asks for action.** Everything else is evidence.
- **Authority by absence.** Mission control may stop the line but cannot pass a product, sign an intent or record a check's result: those have no tool.
