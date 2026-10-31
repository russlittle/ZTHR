# ZTHR: A Pattern Language for Autonomous Software Delivery

[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.23826734.svg)](https://doi.org/10.5281/zenodo.23826734) [![License: CC BY 4.0](https://img.shields.io/badge/License-CC%20BY%204.0-lightgrey.svg)](https://creativecommons.org/licenses/by/4.0/)

**Zero Trust – High Reliability: why software built by AI should earn its quality from the environment, and how to build that environment.**

**Author:** Russ Little · **Version:** 1.0, request for comments · **Released:** October 29, 2026 · **DOI:** [10.5281/zenodo.23826734](https://doi.org/10.5281/zenodo.23826734) · **Site:** [zthr.ai](https://zthr.ai)

---

## Overview

Generative models have made a candidate implementation cheap and the decision about whether it is fit to use expensive. Moving authorship to AI while leaving every later decision in a human review queue does not remove the bottleneck. It moves it, and under volume the reviewer becomes either the constraint on delivery or a rubber stamp.

ZTHR is a pattern language for delivering software written by AI without relying on human diff inspection to hold quality together. It draws on precision manufacturing (jigs, go/no-go gauges, datum-based measurement and calibration to the as-built system), high-reliability organizations and zero-trust security, and rests on two principles:

1. **Symmetric Zero Trust.** No author, reviewer, model, operator or report gains authority by asserting success. A claim counts only on evidence the claimant does not control, in four directions: the author at build time, models at run time, the checks themselves, and the automation that operates the pipeline.
2. **The Fixture Inversion.** Quality moves out of the author's skill and into the environment. Governed jigs constrain what can be built, gauges proven to fail on their target defects judge what was built, and locked statements of user intent serve as the primary datum. Models iterate across attempts until every fixture is satisfied.

> Instead of asking *"Is this code good?"*, every reviewer, auditor and engineer asks:
> **"Which fixture forces that, and has it been shown to bite?"**

## What's in the paper

Three ways in, by depth:

| Read | Markdown | PDF |
| :--- | :--- | :--- |
| Executive summary, two pages | [SUMMARY.md](SUMMARY.md) | [PDF](pdf/ZTHR-executive-summary.pdf) |
| The brief, five pages | [BRIEF.md](BRIEF.md) | [PDF](pdf/ZTHR-brief.pdf) |
| The full paper, all thirty-three patterns | [PAPER.md](PAPER.md) | [PDF](pdf/ZTHR-paper.pdf) |

Building agents or tooling? [`zthr-patterns.json`](zthr-patterns.json) holds all thirty-three patterns as data: problem, forces, pattern, consequences, family and related patterns.

Thirty-three patterns in six families, from construction through runtime:

| Family | What it forces | Patterns |
| :--- | :--- | :--- |
| Construction (jigs) | What can be built at all | 1–6 |
| Verification (gauges) | That code meets stated properties, and that the checks themselves can fail | 7–14 |
| Intent | That the product still does what its users came to do | 15–18 |
| Independence | That a reader without the author's story agrees | 19–22 |
| Operational | That work keeps moving, and what serves is what passed | 23–27 |
| Runtime and environment | That models stay within policy at the moment of use, and that integrations hold against calibrated twins | 28–33 |

Beyond the patterns, the paper covers:

- **Authority and the control plane (Section 11):** how rules, ratchets and datums are governed so no agent can weaken the policy that judges its own output.
- **The learning loops (Section 12):** how escapes and stalls become shared fixtures, and how the system finds what nobody thought to test.
- **Failure tracing (Section 13):** illustrative failures followed through independent representations: source, database, built artifact, rendered screen and running service.
- **Measurement and economics (Section 16):** intent completion as the headline measure, compared against the incumbent process, and spending compute to save attention.

## Feedback

This is version 1.0, released for peer review. Sharp pushback is welcome, especially on the open questions in Section 19.2:

1. **Correlated failure.** Which plausible failure could pass through every representation at once?
2. **Iteration pressure.** When should a generation loop restart from a clean base rather than keep iterating?
3. **Specification quality.** Beyond mapping to the commons and first-principles review, what catches a wrong requirement earliest?
4. **Setting the bar.** How should a field set accuracy standards for AI-delivered work, measured against the human level already accepted there?
5. **Held-out evidence.** Which long-run observations best show that measured safety reflects generalization rather than tuning?

Comment in [Discussions](https://github.com/russlittle/ZTHR/discussions), in the category for the pattern family, and name the pattern number in your title.

## Author's note

Jigs, gauges and datums are not only metaphors borrowed for software here. ZTHR grew out of practice: I first used this concept driving manufacturing robots from 3D models in the late 1990s, programming robot cells and verifying parts to tolerance in precision aerospace manufacturing. I had to keep changing the software to meet the physical gates of the real world machine. We did this in a loop to correct our errors until the system locked in a quality result. Ai can do the trial and error now, while we hold the measurement threshold and define success. I have a passion for building self-correcting and improving systems, and decades of experience leading software & data teams and running large application portfolios.

## Cite

Little, R. (2026). *ZTHR: A Pattern Language for Autonomous Software Delivery* (Version 1.0). Zenodo. https://doi.org/10.5281/zenodo.23826734

See [CITATION.cff](CITATION.cff).

## License

© 2026 Russ Little. The paper and site content are licensed under [Creative Commons Attribution 4.0 International (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/). Use it, adapt it and build on it, with credit to the source.
