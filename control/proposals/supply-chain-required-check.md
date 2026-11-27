# Proposal: make "Supply chain" a required check

**For the owner to decide.** Nothing in `control/` has been changed; this file only proposes an edit to `control/required-checks.yaml` and the branch protection it governs.

## The check

`.github/workflows/supply-chain.yml`, job `evidence` (status check name `Supply chain / evidence`), on every pull request and on push to `intent-surface`. It fails when:

- a production npm dependency has no licence, or one outside the allow list (Apache-2.0, MIT, BSD-2-Clause, BSD-3-Clause, ISC, 0BSD, BlueOak-1.0.0, CC0-1.0, Python-2.0);
- the Files artefact (what `files/Dockerfile` puts in `/app`) does not rebuild to the same SHA-256 from two clean copies;
- the image built from the commit holds anything other than exactly that artefact;
- `files/Dockerfile` gains an instruction whose effect on `/app` the tool cannot derive (for example `RUN npm install` or `ADD <url>`);
- a project declares npm dependencies with no lockfile to pin them;
- the supply-chain tools' own tests fail.

## Proposed change

Add `Supply chain / evidence` to the required checks for `intent-surface` (and `main`, if the workflow's `push` trigger is extended to it).

## Why it should be required rather than advisory

Each failure above is a change to what ships that no other check sees: a new licence obligation, a non-deterministic or unexplained artefact, or a build step that fetches code at image-build time. Without the gate, the attestations are still produced but can silently describe an artefact nobody checked.

## Related decisions for the owner

1. **Pin the base image by digest** in `files/Dockerfile` (`FROM node:22-slim@sha256:...`) so the runtime under `/app` is fixed and can be listed.
2. **Attest the deployed image.** The Cloud Run image is built by Cloud Build and not attested; building and pushing it from this workflow (or adding provenance in Cloud Build) would bind the running service to the evidence.
3. **SLSA Build L3** needs the build moved into a reusable workflow isolated from the signing step.
