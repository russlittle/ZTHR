# Maintenance

> The crew that keeps the factory floor running: anyone tags what is not working instead of stopping the line, and a crew works the tags overnight, through the same gates as day work, and reports each morning.

## TL;DR

The plant runs two shifts. The day shift builds. Anyone, and any gate, reviewer, fuzz run, user report or calibration run, tags what is not working instead of stopping the line: what is wrong, where, how it is known, and the test that will prove it fixed. The night shift is maintenance, the support crew that keeps the [factory floor](factory.md) running and getting better: a crew that works the tags, once accepted as work orders, at {{night.stations}} stations ({{night.stationNames}}), accepts a fix only through the gates day work passes, escalates anything above its tier, and ends with a morning report: what was fixed, with its evidence; what was escalated, and why; what is new on the list. Where it stands: {{night.status}}

{{diagram:maintenance}}

## Explain it simply

A plant that runs one shift stops whenever something is wrong. A plant that runs two keeps going: the day crew hangs a tag on anything that is off (this gauge reads high, this belt is fraying, a customer sent back this part) and carries on. At night the maintenance crew walks the tags. They fix what they can, the same way the day crew would have to, and the inspector checks their work. Anything too big for them gets a note for the plant manager. In the morning there is a sheet on the manager's desk: fixed, with the proof; waiting for you, and why; and the new tags.

The lab tests the inspectors' gauges on parts made wrong on purpose. When a gauge says *fine* on a bad part, the lab tags it, and the night crew repairs it.

## Engineer

### What the maintenance page shows

- **The morning report.** The last shift: what was fixed, each with its evidence; what was escalated, to whom and why; what is new on the list.
- **The list, by station and kind.** Open tags at each station, and the queue by task kind in round order, with what each kind must prove to be accepted.
- **Gauge repair.** Each block's mutation score from metrology's certificate, what survived and what is recorded as equivalent: the work orders still open.
- **The crew.** Cost per accepted change, time from tag to fix, pass rate per model per kind, and the dated price table the router reads.

### The stations

{{table:stations}}

### What a tag holds

A tag is raised instead of stopping the line, and it is refused without all four of these: **what** is wrong; **where** (the block, the file, the line); **how it is known** (the evidence: the failing run, the surviving mutant, the advisory, the report); and **the test that will prove it fixed**. The tag's life:

{{diagram:tag-life}}

### The task kinds

Every tag is worked as tasks of {{night.kinds}} kinds. Mutation work goes in this order each round: fix what a new test found, then kill what survived, then simplify what did nothing.

{{table:task-kinds}}

Every kind passes the same gates as day work: a failing test first; then the fix; nothing weakened (no test removed or loosened, no floor lowered, no locked path touched); and an independent check by a model of another family than the one that made the fix.

### Gauge repair: the mutation loop

A test is a gauge. Metrology calibrates each block by planting defects (mutants); a mutant that survives is a defect a gauge failed to reject, and each one is a work order here. Metrology measures and certifies; maintenance repairs. The repair has two parts, the tests and then the fixes:

- **fix-bug.** A newly written killing test failed on the real code as well as on the mutant: it found a real defect. The fix is made with that test attached.
- **kill-mutant.** The missing test is added. It must fail on the mutant and pass on the real code.
- **simplify.** An equivalent mutant (one no test can tell from the real code) points at code that does nothing. It is removed or tightened while every test still passes.

A claim that a mutant is equivalent counts only when a judge from a different model family agrees, and the ruling is recorded with its reasoning. The ratchet is the backstop: a block's score cannot go down, and a higher floor is proposed for a person to sign, because floors are person-only. The fixes are the point. The loop repeats until no survivors remain but recorded equivalents.

{{diagram:mutation-loop}}

Scores per block, from metrology's certificates ({{night.scored}}):

{{table:night-scores}}

### The crew

A router staffs every task with the cheapest model proven good enough for its kind. A model is proven for a kind by its measured pass rate there; a model not yet measured is tried on trial; a model below the bar is left out for that kind. A task that fails moves a tier up; past the top tier it goes to a person, in the morning report. A task the day's budget cannot cover waits for the next shift: nothing is skipped.

{{diagram:crew-routing}}

The router reads a dated price table: {{crew.where}}, USD per 1M tokens, as listed on {{crew.checked}}. It is re-read and re-dated when the list changes, never assumed current.

{{table:crew}}

{{diagram:crew-prices}}

Pass rates per model per kind, from every settled task:

{{table:night-rates}}

### Where the crew runs

On the owner's Google Cloud project, through Workload Identity Federation: each run is given a short-lived identity, and no key is stored anywhere. The runner is still being built and is not live yet; until it is, no shift runs, and the maintenance page says so.

### What maintenance records

{{diagram:night-erd}}

Every figure maintenance reports is read from these records: a shift log per night; per-block mutation scores and survivors; cost per accepted change ({{night.cost}}); pass rate per model per task kind; and time from tag to fix ({{night.tagToFix}}).

## Architect

Maintenance is total productive maintenance applied to a software line: the instruments are maintained as carefully as the product, and upkeep is scheduled work, not an interruption.

- **A support crew for the factory floor, not a step in the flow.** Tags can come from anywhere, and that is a source of work orders, not a service relationship: maintenance serves the factory floor, keeping its builders, gauges and blocks working. Work does not pass through it, and its report goes to mission control.
- **Tag, do not stop.** Stopping the line for every defect stalls everything behind it; ignoring defects lets them compound. A tag with its evidence and its proving test is neither: the line keeps moving, and nothing found is lost.
- **Same gates at night.** A night fix passes exactly what a day change passes. There is no maintenance exemption, so the night shift cannot be the way around a gate.
- **Repair what metrology finds.** Calibration finds tests that cannot fail and code that does nothing; maintenance closes both. Every later product gains: the gauges it inherits are proven, and the blocks it assembles are smaller.
- **The model is chosen by evidence.** Pass rates per model per kind, and the dated prices, decide who takes a task. The fixture, not the model, carries the quality; the router only finds the cheapest model the fixture accepts.
- **Escalation is a reading.** What the crew cannot settle reaches a person with its reasons, in one report a morning, instead of as interruptions through the day.
