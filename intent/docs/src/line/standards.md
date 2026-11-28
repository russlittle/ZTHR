# The standards map

> Each area's discipline and standard, and each function of a manufacturing plant that brings a method, a number or a standard, its equivalent in the software factory, and where the factory stands on it: built and proven, partial, or missing.

## TL;DR

The plant borrows from manufacturing only where manufacturing brings a method, a number or a standard. Every area of the plant is a manufacturing discipline that works to a standard, and the first table names them. The second lists each function ({{standards.summary}}), grouped by the area that carries it out, what it is in the software factory, and the evidence for where it stands. It is the factory's own audit of itself against the plant it is modelled on, and it says plainly what is missing.

{{diagram:plant}}

## Explain it simply

This page is not the plant itself: [the plant](index.md) is the areas and how work moves between them, and its view at [/plant](https://zthr.ai/plant/) shows where each area stands today. This page is the list of standards behind it. A plant that makes parts has a lab that checks the gauges, inspectors who use them, a maintenance crew, a dock where supplies are checked as they arrive, a records office, and rules for what happens when a batch is bad. The software factory has, or needs, each of these. This page is the list: for each part of the plant, what it is here, and whether it is really there yet.

## Engineer

### Why these methods apply

A classic software build is deterministic: the same source gives the same result every time, so software never needed the statistics a plant uses to manage variation. AI workers bring variation back. The same task can pass on one run and fail on the next, and models differ in their defect rates. The plant's measurement disciplines (gauge R&R, control charts, certified gauges, first article inspection) were made for exactly that, and the factory's own records (pass rates per model per task kind, flake rates, mutation scores) are the data those methods consume.

### The line of practice

The factory stands in a long line of practice. Shewhart's control charts and Deming's quality system made variation something to measure rather than argue about; the Toyota Production System added stopping the line at a defect and maintaining equipment as planned work; automotive and aerospace quality turned measurement itself into a discipline, with measurement systems analysis (AIAG) and first article inspection (AS9102); lean software and DevOps carried flow and its measures into software delivery (the DORA measures of throughput and stability). AI workers reintroduce the process variation those disciplines were built for, so they apply directly rather than by analogy.

### The disciplines

Each area is one discipline, worked to one standard. This table is drawn from the plant model:

{{table:standards-areas}}

### The map

{{table:standards-map}}

## Architect

- **A method, a number or a standard, or nothing.** A plant word is used here only where it brings one of the three, and the standard is named. Everywhere else the plain names are used: tag, gate, improvement brief.
- **Standing is evidence.** Built and proven means a test or a record shows it; partial means some of it exists and the gap is named; missing means it does not exist yet. Nothing on this map is promoted by intention.
- **The gaps are the plan.** Each missing or partial line is work: a reference to record, a measure to take, a gate to add. The areas that own them are named in the first column: [metrology](metrology.md) for the measures and certificates, [maintenance](maintenance.md) for the repairs, [manufacturing engineering](process.md) for the control plan and the gates.
