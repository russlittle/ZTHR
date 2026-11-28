# Metrology

> The lab beneath the line: it defines every measure QA uses, traces each to a reference standard, certifies every gauge before QA may use it, charts the factory's own process for drift, and audits the factory's claims against their evidence.

## TL;DR

QA judges builds; metrology judges QA's instruments. Every measure is defined once, here, and traced to a reference: published test vectors, a recording of the system a product replaces, sealed held-out phrasing sets. Every gauge gets a dated certificate: its capability (the mutation score of its block: does each test reject a planted defect), its repeatability (the flake rate) and its reproducibility (the same verdicts in a fresh clone and on CI), re-checked nightly and whenever its code changes. QA may use only gauges metrology has certified. Where it stands: {{lab.status}}.

{{diagram:metrology}}

## Explain it simply

An inspector's gauge is only as good as its last check. The lab keeps the master blocks every gauge is compared with, checks each gauge on parts made wrong on purpose, checks that it reads the same twice and in anyone's hands, and puts a dated sticker on it. Inspection may only use a gauge with a current sticker. The lab also keeps charts of how the plant is running, so a slow drift is seen before it becomes a bad batch, and it checks that what the plant says about itself is true.

## Engineer

### What the metrology page shows

- **Gauges QA may use.** Blocks certified, against blocks in the library.
- **Calibration certificates.** Per block: capability, survivors, rulings, repeatability, reproducibility and the date issued.
- **The measures QA uses and the reference standards** they trace to, each with where it stands.
- **Control charts** on the factory's own process, and how many points each has.
- **The internal audit**: every claim the factory makes about itself, against its evidence.

### The measures

{{table:measures}}

### Reference standards

{{table:references}}

### Certificates

A certificate is earned in order: capable first, then repeatable and reproducible. Calibration runs every block nightly and a block again whenever its code changes; every surviving mutant is tagged as a work order for maintenance, which repairs it. A claim that a mutant is equivalent counts only when a judge of another model family agrees, recorded with its reasoning.

{{diagram:certification}}

The {{lab.calibrated}} blocks calibrated so far, of {{lab.blocks}}:

{{table:certificates}}

### Control charts

Each series is an individuals chart after Shewhart: the centre line is the mean, and the limits are three sigma, with sigma estimated from the average moving range. Drift is read by the Western Electric rules (one point beyond three sigma; two of three beyond two; four of five beyond one; eight in a row on one side), and every signal raises a tag. A series has no limits until it has {{lab.minPoints}} points, the number the AIAG SPC manual asks for, so until then it raises nothing. The series: test time, flake rate, mutation score and cost per accepted change.

### The internal audit

Every claim the factory makes about itself is checked against its evidence and recorded as proven, partial or unproven. The audit of {{audit.checked}} found {{audit.summary}}:

{{table:audit-findings}}

### What metrology records

{{diagram:metrology-erd}}

## Architect

- **Beneath the line.** Metrology serves QA first, but also the factory's required checks, the oracle the fleet relies on, and the service levels shipping watches. It has no place in the order work moves through, so it sits beneath the line beside maintenance: metrology measures and tags; maintenance repairs.
- **Methods, not metaphors.** Gauge R&R, control charts and certified gauges are used here because AI workers vary from run to run, and those methods were made for variation; [the plant map](plant.md) says why, and where each stands.
- **A certificate is a reading, not a promise.** It is dated, it names its interval, and it lapses when the gauge's code changes. A gauge without a current certificate is not used, and the page says which.
- **Audit the factory, not only the product.** The claims audit applies the same rule to the factory that QA applies to a build: nothing counts on assertion.
