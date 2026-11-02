# Clean-room provenance

This repository is an independent implementation of the ZTHR pattern language, built from the public paper
(*ZTHR: A Pattern Language for Autonomous Software Delivery*, Russ Little, DOI 10.5281/zenodo.23826734) and from
Russ Little's own explanations of approach. No code, documents, configuration, prompts, schemas or data from any
employer were opened, copied or referenced. Names throughout are new.

Each component below records the paper section or pattern it implements and the date it was written.

| Component | Implements | Written |
| --- | --- | --- |
| `packages/gates` verdicts | Pattern 9, Unknown Is a State | 2026-11-02 |
| `packages/gates` gates and proofs | Pattern 8, Prove the Gate Can Fail; Pattern 2 purpose notes | 2026-11-02 |
| `packages/gates` ratchets and reset ledger | Pattern 10, Ratchet; section 11 authority rules | 2026-11-02 |
| `packages/gates` datums | Pattern 12, Measure From the Datum | 2026-11-02 |
| `packages/gates` findings register | Pattern 13, Register Don't Suppress | 2026-11-02 |
| `packages/evidence` | Section 16 measures; cost ledger design | 2026-11-02 |
| `packages/runtime` approval tokens | Pattern 30, Authorization by Absence; Pattern 24 rubric (outside audience) | 2026-11-02 |
| `packages/runtime` safety router, sandwich | Pattern 28, Deterministic Sandwich; Pattern 31, Fail Closed Keep Serving | 2026-11-02 |
| `packages/runtime` startup guard | Pattern 29, Refuse to Start Misconfigured | 2026-11-02 |
| `packages/runtime` consent ledger, sealed store | Pattern 30; Pattern 20, Roles Defined by What They Are Denied | 2026-11-02 |
| `packages/models` | Pattern 19, Determinism Ladder; budgets as fixtures | 2026-11-02 |
| `packages/review` | Pattern 21, Multi-Family Review; Pattern 20 | 2026-11-02 |
| `packages/intent` | Patterns 15 to 18, Intent as Datum, Walk Like a User, Oracles From the Record, Locked Intent | 2026-11-02 |
| `packages/twins` | Pattern 33, Twin What You Don't Own | 2026-11-02 |
| `apps/advocate` | The Student Advocate PRD, built under the factory | from 2026-11-02 |
