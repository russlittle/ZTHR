# Manufacturing engineering

> Define how to build the product from the product spec: the build package, its routing, fixtures, gates and required checks. Then keep improving the line and the process from what the line measures.

## TL;DR

Product engineering says *what* is built; manufacturing engineering says *how*. It takes the released product spec and writes the build package the factory floor builds to: the routing (the {{delivery.stages}} delivery stages, in order), the fixtures (gauges, working ranges, starting ratchets), the gates, each proven able to fail, and the {{checks.required}} required checks every change must pass. It then sets up the line to build it, and keeps improving the line, QA and shipping from what the line measures: process capability, which is not measured yet.

{{diagram:process}}

## Explain it simply

The drafting office has drawn the shelf. The process planners decide how the shop will make it: which steps, in which order, with which jigs, which gauge at each step, and which checks the shelf must pass before it moves on. They test the checks on purpose-made bad parts, so a check that cannot fail is thrown out. They hand the shop floor a binder, and after that they watch how the shop runs and change the binder when a step is slow, wasteful or lets a defect through.

## Engineer

### The build package

The build package holds what the factory floor needs and nothing it has to invent: the routing, the control plan, the gauges, the working ranges and starting ratchets, the pending tests and the agents' brief. For the worked example it sits inside the released revision, counted by folder:

{{table:package}}

### The routing

Every product follows the same routing, written once and neutrally in `src/delivery.ts`, with each cloud as an adapter over it:

{{table:stages}}

The routing is defined for every product; which stages a product has run is recorded by its pipeline, not here.

### Gates proven able to fail

There are {{gates.count}} structural gates. A gate counts only while its planted defects still make it fail, so each names the tests that plant them and how many there must be at least; a proof that matches no test, or fewer than it did, fails the run instead of passing quietly.

### Required checks

{{table:checks}}

Checks run cheapest first and stop at the first failure.

### What the process page shows

The routing, the gates with their proofs, the required checks and whether the branch rules are recorded, read from the repository when the site is built; the gate proofs and ratchets the latest build measured; and process capability, which shows *not measured yet* until the line's runs are recorded.

## Architect

Manufacturing engineering is the area that makes the line better, not only the product: a defect that reaches QA twice is a defect in the routing.

- **Fixtures before work.** The factory floor does not start from a blank page. Everything it needs to check its own work is in the build package, so a builder designs only the delta.
- **A gate that cannot fail is not a gate.** Every gate is shown to fail on a planted defect before it counts, and goes back to unproven the day its proof stops holding.
- **Enforcement is a record, not a promise.** The required checks are enforced on the branch only where the live branch rules are recorded and compared with GitHub's; until then the page says they are not.
- **Capability is measured from the line.** Whether the process holds its own measures over many runs is read from the line's records and charted by [metrology](metrology.md); nothing is claimed before there are runs to chart.
- **It serves the whole line.** It improves the [factory floor](factory.md)'s routing, [QA](qa.md)'s gates and [shipping](shipping.md)'s stages from what each measures, and hands the next product a better package.
