/**
 * The plant map: each function of a manufacturing plant that brings a method, a number or a standard, its
 * equivalent in the software factory, and where the factory stands on it, with the evidence. The standing is said
 * plainly: built and proven, partial, or missing.
 */
import type { Standing } from '../src/console/lab.ts';

export interface PlantFunction {
  readonly plant: string;
  /** The standard or method it brings, when there is one. */
  readonly standard: string;
  readonly factory: string;
  readonly standing: Standing;
  readonly evidence: string;
}

export const PLANT: readonly PlantFunction[] = [
  { plant: 'Metrology lab', standard: 'ISO 10012 measurement management', factory: 'Metrology: defines every measure QA uses and certifies every gauge', standing: 'partial', evidence: 'Calibration runs nightly and on change (night-shift workflow, tools/mutation); repeatability and reproducibility are not measured yet' },
  { plant: 'Reference standards', standard: 'Traceability to a reference (ISO/IEC 17025)', factory: 'Published test vectors, a recording of the replaced system, sealed held-out phrasing sets', standing: 'partial', evidence: 'Some blocks test against their RFC’s vectors; no Nextcloud recording yet; held-out sets sealed by convention only' },
  { plant: 'Gauge R&R', standard: 'AIAG Measurement Systems Analysis', factory: 'Repeatability: the flake rate. Reproducibility: the same verdicts in a fresh clone and on CI', standing: 'missing', evidence: 'Neither is measured. Builds are reproducible byte for byte (tools/supply/repro.ts); test verdicts are not yet compared' },
  { plant: 'Calibration certificates and intervals', standard: 'ISO 9001 clause 7.1.5', factory: 'A dated certificate per block: mutation score, survivors, rulings; re-run nightly and on every change', standing: 'partial', evidence: 'Certificates are written to eval/mutation/ as blocks are calibrated; most blocks have none yet' },
  { plant: 'Gauge capability', standard: 'AIAG Measurement Systems Analysis', factory: 'Mutation score per block: does each test reject a planted defect', standing: 'partial', evidence: 'Measured for the blocks calibrated so far; every survivor is a work order' },
  { plant: 'Measurement system analysis of a fixture', standard: 'AIAG Measurement Systems Analysis', factory: 'The Files oracle checked on planted differences: what it must report, what it must mask', standing: 'partial', evidence: 'The oracle’s unit tests plant differences; there is no recorded corpus to run a planted-difference suite on' },
  { plant: 'Inspection (QA)', standard: 'ISO 9001 clause 8.6', factory: 'Journeys walked as a person would; gates proven on planted defects; QA uses only certified gauges', standing: 'partial', evidence: 'Gates carry planted-defect proofs; no gauge is certified yet, so the rule that QA uses only certified gauges is not met' },
  { plant: 'Maintenance', standard: 'Planned maintenance work orders', factory: 'The night shift: work orders from every tag, through the same gates as day work', standing: 'partial', evidence: 'Work orders and their acceptance gate exist (tools/mutation); the crew’s runner is not live, so no shift has run' },
  { plant: 'Incoming inspection', standard: 'CycloneDX SBOM; licence allow list', factory: 'Every dependency in an SBOM, every licence checked; model suppliers qualified by measured pass rates', standing: 'partial', evidence: 'SBOMs and the licence gate run in the supply-chain workflow; model suppliers have a dated price table but no measured pass rates yet' },
  { plant: 'Document control', standard: 'ISO 9001 clause 7.5; AS9100', factory: 'Journey cards locked by hash, the hash-chained ledger, signed provenance', standing: 'partial', evidence: 'The ledger is hash-chained and journeys are locked by hash; branches are not protected, so the record can be bypassed' },
  { plant: 'Engineering change control', standard: 'AS9100 configuration management', factory: 'The intent signed by its holder; every change to it a signed revision', standing: 'partial', evidence: 'A signature is bound to the exact content by hash; unprotected branches leave the repository’s own changes uncontrolled' },
  { plant: 'FMEA', standard: 'AIAG-VDA FMEA Handbook', factory: 'Failure modes per block, ranked by severity, occurrence and detection, each with its preventive test', standing: 'missing', evidence: 'No failure-mode analysis is recorded for any block' },
  { plant: 'Control plan', standard: 'AIAG APQP control plan', factory: 'The required checks and the delivery stages, each with its gate', standing: 'partial', evidence: 'Every stage and gate is defined; the reference pipeline does not yet run the data, signing, candidate, canary or operate stages' },
  { plant: 'First article inspection', standard: 'AS9102', factory: 'A new product’s first build measured against its reference, characteristic by characteristic', standing: 'missing', evidence: 'Files is the first product; its reference recording does not exist yet' },
  { plant: 'Statistical process control', standard: 'Shewhart control charts; Western Electric rules', factory: 'Control charts on test time, flake rate, mutation score and cost per change; a signal raises a tag', standing: 'missing', evidence: 'The chart logic exists in metrology; no series has the 25 points limits need' },
  { plant: 'Service monitoring', standard: 'The Site Reliability Workbook, burn-rate alerts', factory: 'Error budgets watched in service; a fast burn rolls back', standing: 'missing', evidence: 'Service levels are generated with the package; the reference pipeline does not watch them yet' },
  { plant: 'Nonconformance and review board', standard: 'ISO 9001 clause 8.7', factory: 'A red build stops work on that line until it is dispositioned', standing: 'missing', evidence: 'The reference build was red for 13 days while commits continued' },
  { plant: 'Corrective and preventive action', standard: 'ISO 9001 clause 10.2; AS9100', factory: 'Every fix with its preventive test: a test that fails first', standing: 'partial', evidence: 'The acceptance gate enforces failing-first for mutation work orders; it is a rule, not a gate, for other changes' },
  { plant: 'Andon', standard: 'Stop-and-signal at the station', factory: 'The tag: what, where, evidence and proving test, raised without stopping the line', standing: 'partial', evidence: 'Calibration runs tag every survivor; other departments do not raise tags yet' },
  { plant: 'Poka-yoke', standard: 'Error-proofing by design', factory: 'Gates that make the wrong act impossible: person-only acts have no tool', standing: 'built and proven', evidence: 'A test checks that no agent tool exists for any person-only act and that no tool admits a change' },
  { plant: 'Tool crib', standard: 'Controlled, certified tooling', factory: 'The block library, each block certified before a product uses it', standing: 'partial', evidence: 'The library is catalogued and tested; blocks are not yet issued only on a certificate' },
  { plant: 'Work instructions', standard: 'ISO 9001 clause 8.5.1', factory: 'Task specifications: what may be edited, the acceptance command, the budget', standing: 'partial', evidence: 'Every mutation work order carries them; other task kinds have no written specification yet' },
  { plant: 'Lot traceability', standard: 'AS9100 identification and traceability', factory: 'Commit to artefact digest to deployed digest', standing: 'partial', evidence: 'Builds are reproducible and attested by digest; deploys name a movable tag, not a digest' },
  { plant: 'Certificate of conformance', standard: 'AS9100 release documentation', factory: 'The release record: signed provenance and an SBOM for the exact artefact', standing: 'partial', evidence: 'Provenance and SBOM attestations are made on push; the release record does not yet bind the deployed digest' },
  { plant: 'Internal audit', standard: 'ISO 19011', factory: 'The claims-to-evidence ledger: every claim proven, partial or unproven', standing: 'partial', evidence: 'An audit has been run once (73 claims: 10 proven, 43 partial, 20 unproven); the claim-by-claim ledger is not yet a record the site reads' },
  { plant: 'Registrar audit', standard: 'ISO 17021 certification audit', factory: 'An outside party audits the factory against its own claims', standing: 'missing', evidence: 'No outside audit has been made' },
  { plant: 'Kaizen', standard: 'Continuous improvement', factory: 'The improvement brief: one page a week, what to change and why', standing: 'partial', evidence: 'Catalogued as a part for products; not yet produced for the factory itself' },
  { plant: 'Capacity planning', standard: 'Load against capacity and cost', factory: 'The model router: the cheapest model proven for each task kind, within the day’s budget', standing: 'partial', evidence: 'The router and its dated price table are built and tested; no pass rates are measured yet' },
];
