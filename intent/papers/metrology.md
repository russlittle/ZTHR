# Metrology: Certifying the Instruments Before They Judge

**Patterns for measures defined once and traced to a reference, gauges certified for capability, repeatability and reproducibility, control charts on the factory's own process, and an audit of the factory's claims**

Russ Little · Pattern paper · Draft for review · Nov 27, 2026

v0.1 · Request for comments · © 2026 Russ Little. Licensed under CC BY 4.0. Part of the series rolled up in [The Line](the-line.md).

## Abstract

QA certifies that a build does what was meant, and it does so with instruments: tests, gates, an oracle, journeys. Nothing in QA says whether those instruments are any good. Metrology is the department that does. It defines every measure QA uses and traces each to a reference standard: published test vectors, a recording of the system a product replaces, sealed held-out phrasing sets. It certifies every gauge before QA may use it: capability (the mutation score of a block: does each of its tests reject a planted defect), repeatability (the flake rate) and reproducibility (the same verdicts in a fresh clone and on CI), after the gauge R&R method of AIAG's *Measurement Systems Analysis*. Certificates are dated and lapse on change. It charts the factory's own process (test time, flake rate, mutation score, cost per change) after Shewhart, reads drift by the Western Electric rules, and raises a tag on every signal. And it audits the factory's claims about itself against their evidence. Metrology measures and certifies; maintenance repairs what it finds. It is metrology, to the standards of ISO/IEC 17025 and AIAG's *Measurement Systems Analysis*, done by a crew; it keeps QA's quality and process true. This paper sets out eight patterns for that work, and says plainly where the plant stands.

> **Central proposition.** Judge a build only with instruments that have themselves been judged: defined once, traced to a reference, shown to reject planted defects, shown to give the same answer twice and anywhere, and watched over time for drift.

## 1. The problem

- **Tests nobody tests.** A suite that always passes is indistinguishable from a suite that cannot fail.
- **Flaky verdicts.** A test that passes on one run and fails on the next turns every verdict into a coin toss, and is quietly retried until green.
- **Measures without a reference.** "The oracle agrees" means nothing unless the thing it agrees with is the real system, recorded.
- **Drift nobody sees.** Test time creeps up, a model's pass rate slides, cost per change doubles over a month; each day looks like the last.
- **Claims that outrun their evidence.** A factory that describes itself says more than it has proven, and nothing checks.

```mermaid
flowchart LR
  REF[(Reference standards)] --> MEAS[Measures, defined once]
  MEAS --> CAL[Calibration: planted defects]
  CAL --> RR[Gauge R&R: again, and in a fresh clone]
  RR --> CERT[Certificate, dated, with its interval]
  CERT --> QA[QA uses only certified gauges]
  CAL -. survivors .-> MT[Maintenance: work orders]
  SPC[Control charts on the factory] -. a signal .-> MT
  AUD[Claims audit] --> MC[Mission control]
```

## 2. Where metrology sits

Metrology is the lab behind QA: it takes in every gauge QA uses, and gives back certified gauges and a better QA process. It serves QA, and QA uses only the gauges it has certified. Some of what it certifies is used elsewhere too (the required checks on the branch, the oracle, the service levels shipping watches), but its service relationship is with QA. It receives nothing from the area before it and hands nothing to the one after, so it has no place in the flow of work: it stands beside QA, and beside its sister crew, maintenance. Metrology measures, certifies and tags; maintenance repairs.

```mermaid
flowchart LR
  FF["Factory floor"] -- "built product" --> QA["QA"]
  QA -- "passed" --> SH["Shipping"]
  QA -- "failed" --> RW["Rework"]
  subgraph MG["Metrology: the lab behind QA"]
    direction TB
    DEF["Measures, defined once"] --> TR["Traced to a reference"] --> CE["Gauges certified"]
    SPC["Control charts on the plant's process"]
    AUD["Claims audit"]
  end
  CE -- "certified gauges" --> QA
  QA -- "every gauge it uses" --> MG
  MG -. "survivors, signals: work orders" .-> MT["Maintenance"]
  AUD --> MC["Mission control"]
```

## 3. Principles

**No measure without a reference.** A measure is defined once, with its unit, and traced to a standard outside the factory's control.

**No verdict from an uncertified gauge.** QA may use a gauge only while its certificate is current.

**A claim is a measurement.** What the factory says about itself is proven, partial or unproven, and is checked like anything else.

## 4. Patterns

### Pattern 1. Measures Defined Once

**Problem.** Each area measures "passing" its own way, and the numbers cannot be compared.

**Pattern.** Every measure QA uses is defined in one place: what it is, its unit, and what it is traced to.

| Measure | Defined as | Unit | Traced to |
| --- | --- | --- | --- |
| Gauge capability | Of the planted defects in a block, the share its tests reject | % of mutants killed | The block's own code, mutated |
| Repeatability | The share of tests that change verdict when run again, unchanged, on the same machine | % of tests (the flake rate) | AIAG *Measurement Systems Analysis* |
| Reproducibility | Whether the same commit gives the same verdict on every test in a fresh clone and on CI | tests that disagree | AIAG *Measurement Systems Analysis* |
| Oracle discrimination | Of the differences planted in a recorded corpus, the share reported; of the rightful differences, the share masked | % detected, % masked | The recording of the replaced system |
| Journey pass | A person's goal reached in every mode and channel named, with nothing forbidden happening | pass, fail or not measured | The signed intent and the held-out phrasings |

### Pattern 2. Traced to a Reference

**Problem.** A gauge checked only against the factory's own idea of correct inherits the factory's mistakes.

**Pattern.** Every measure traces to a reference the factory does not write: a specification's published test vectors; a recording of the real system a product replaces, captured once and replayed against every build; sets of phrasings held out from the factory and sealed, so a pass cannot be memorised.

| Reference | What it is | Standing |
| --- | --- | --- |
| Published test vectors | A specification's own vectors, run against the block | Shown per block on [/plant](https://zthr.ai/plant); no catalogue yet says which measure traces to which vector |
| A recording of a real Nextcloud, for the Files oracle | The replaced system's answers, captured once | The oracle can replay a recorded corpus; whether a recording exists is shown on [/plant](https://zthr.ai/plant), and without one the oracle's verdicts are traced to nothing outside the plant |
| Sealed held-out phrasing sets | Phrasings the builder never sees | Held in a person-only path and sealed by convention; no hash that a gate checks |

### Pattern 3. Certified Before Use

**Problem.** A gauge is trusted because it exists.

**Pattern.** Each gauge earns a certificate in order. Capability first: every planted defect its tests can tell apart is rejected, and every survivor is either killed or ruled equivalent by a judge of another model family, with its reasoning recorded. Then repeatability and reproducibility. Only a certified gauge may give QA a verdict.

```mermaid
stateDiagram-v2
  [*] --> NotMeasured
  NotMeasured --> NotCertified: calibrated, survivors remain
  NotCertified --> CapabilityOnly: every survivor killed or ruled equivalent
  CapabilityOnly --> Certified: repeatable and reproducible
  CapabilityOnly --> NotCertified: a test changes verdict, or a fresh clone disagrees
  Certified --> NotCertified: the block's code changes, calibrated again
  Certified --> Certified: nightly re-calibration holds
```

Each survivor is a work order for maintenance: add the missing test, fix the defect a new test finds, or remove code that does nothing.

### Pattern 4. Gauge R&R

**Problem.** AI workers vary from run to run, and so can the tests they write. A gauge whose verdict varies cannot separate a good build from a bad one.

**Pattern.** After AIAG's gauge repeatability and reproducibility study, each block's suite is run again, unchanged, on the same machine (repeatability: the flake rate) and in a fresh clone and on CI (reproducibility: do the verdicts agree). A flaky test is a tag, never a retry. A build that reproduces byte for byte is already checked (the supply chain's reproducible-build tool); test verdicts are not compared yet.

### Pattern 5. A Certificate Has an Interval

**Problem.** A gauge proven once is assumed proven forever.

**Pattern.** A certificate is dated and names its interval: every block is calibrated nightly, and a block again whenever its code changes. A change lapses the certificate until the next calibration holds. The score a certificate records cannot fall: a change that lowers it fails, and a higher floor is proposed for a person to sign, because floors are person-only.

### Pattern 6. Measure the Oracle

**Problem.** An oracle that compares a product with the system it replaces is itself an instrument, and can mask a real difference or report a rightful one.

**Pattern.** The oracle is put through a measurement system analysis of its own: a suite of planted differences in a recorded corpus, each of which it must report, and rightful differences (etags, ids, dates, tokens), each of which it must mask. Its discrimination is a measure like any other. The oracle's unit tests plant differences; the planted-difference suite needs a recorded corpus to run on.

### Pattern 7. Control Charts on the Factory

**Problem.** A process that drifts slowly looks normal every day.

**Pattern.** Metrology charts the factory's own process: test time, flake rate, mutation score and cost per accepted change. Each is an individuals chart after Shewhart, with the centre at the mean and limits at three sigma estimated from the average moving range. Drift is read by the Western Electric rules, and every signal raises a tag for maintenance.

| Rule | Signal |
| --- | --- |
| 1 | One point beyond three sigma |
| 2 | Two of three consecutive points beyond two sigma, on one side |
| 3 | Four of five consecutive points beyond one sigma, on one side |
| 4 | Eight consecutive points on one side of the centre |

```mermaid
flowchart LR
  P[New point: a run, a change, a shift] --> N{25 points yet?}
  N -- no --> W[Plotted; no limits, no signal]
  N -- yes --> L[Limits from the moving range]
  L --> R{Any Western Electric rule?}
  R -- no --> OK[In control]
  R -- yes --> T[Tag: the series, the point, the rule]
  T --> MT[Maintenance]
```

A series has no limits until it has 25 points, as the AIAG SPC manual asks, so a new plant raises no false alarms. Which series have their 25 points is shown on [/plant](https://zthr.ai/plant).

### Pattern 8. Audit the Factory's Claims

**Problem.** A factory's description of itself is its least checked output.

**Pattern.** Every claim the factory makes about itself is entered in a claims-to-evidence ledger and checked: proven (a test or record shows it), partial (some of it exists, and the gap is named) or unproven. The audit is repeated, and each finding becomes a tag. The counts of proven, partial and unproven claims are those of the latest audit, shown on [/plant](https://zthr.ai/plant) and in the claims ledger; they are not typed here.

```mermaid
stateDiagram-v2
  [*] --> Unproven: the claim is entered
  Unproven --> Partial: some of it has evidence, the gap is named
  Partial --> Proven: a test or record shows all of it
  Proven --> Partial: the evidence lapses
  Unproven --> Proven: a test or record shows all of it
```

Gaps the audit of 27 November 2026 found, which stay listed until the ledger shows them closed:

1. Review by two other model families is designed but not running.
2. Branches are not protected, so the record can be bypassed by a direct push.
3. There is no recording of a real Nextcloud for the Files oracle.
4. Held-out sets are sealed by convention, not by a hash a gate checks.
5. Deploys name a movable image tag, not a digest.

## 5. What metrology records

```mermaid
erDiagram
  REFERENCE ||--o{ MEASURE : "traces"
  MEASURE ||--o{ GAUGE : "is taken by"
  GAUGE ||--o{ CERTIFICATE : "is certified by"
  CERTIFICATE ||--o{ SURVIVOR : "lists"
  SURVIVOR ||--o| RULING : "may be ruled equivalent by"
  SURVIVOR ||--o| TAG : "is tagged for maintenance as"
  CONTROL_CHART ||--o{ POINT : "plots"
  POINT ||--o| TAG : "a signal raises"
  CLAIM ||--o{ EVIDENCE : "is proven by"
  REFERENCE {
    string id
    string name
    string standing "built and proven, partial, missing"
  }
  MEASURE {
    string id
    string defined
    string unit
    string reference
  }
  GAUGE {
    string id "a block's tests, a gate, the oracle, a journey"
    string measure
  }
  CERTIFICATE {
    string gauge
    datetime issued
    number capability "mutation score"
    number repeatability "flake rate"
    boolean reproducible "fresh clone and CI agree"
    string state "certified, capability only, not certified, not measured"
    string interval "nightly, and on change"
  }
  SURVIVOR {
    string id
    int line
    string mutator
    string original
    string replacement
  }
  RULING {
    string claimant
    string judge "another model family"
    string verdict
    string reasoning
    datetime at
  }
  CONTROL_CHART {
    string metric
    number centre
    number ucl
    number lcl
  }
  POINT {
    datetime at
    number value
    int rule "Western Electric rule signalled, if any"
  }
  CLAIM {
    string id
    string text
    string standing "proven, partial, unproven"
    date checked
  }
  EVIDENCE {
    string claim
    string link
  }
```

## 6. Files, in the lab

Files is the plant's first article: its first build measured, characteristic by characteristic, against the system it replaces (AS9102 first article inspection). That needs the reference: a recording of a real Nextcloud answering the requests its clients make. With the recording, the oracle is measured on planted differences, and every library block Files is made of is calibrated and certified before QA uses its tests. Without it, the oracle's verdicts are traced to nothing outside the factory, and the first article inspection cannot be made.

## 7. What it needs, and how it is judged

Metrology needs planted-defect calibration of every gauge, repeatability and reproducibility measured, and every claim audited against its evidence. Certification needs every planted defect caught, so a gauge is not certified while any survivor remains; how many gauges are certified, and the median mutation score, are shown on [/plant](https://zthr.ai/plant). The measures:


- **Certified share.** The share of gauges QA uses that hold a current certificate. It should reach all of them; until it does, QA's rule is not met, and that is a reading.
- **Discrimination.** For the oracle, planted differences reported and rightful differences masked.
- **Stability.** Flake rate and reproducibility per block, over time.
- **Drift found.** Signals raised by the control charts, and how many became fixes.
- **Honesty.** The share of the factory's claims proven, audit by audit.

## 8. What it does not claim

Metrology does not make a gauge correct: it shows how well a gauge discriminates, how consistently it reads, and what it is traced to. It does not replace the reference standards: where a reference is missing, it says the measure is traced to nothing outside the factory. And it does not prove the factory's claims: it records which are proven, and which are not yet. The reason these methods apply to software at all is set out in [The Line](the-line.md), with the plant map.
