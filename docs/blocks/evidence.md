# @zthr/evidence

Append-only, pseudonymous evidence: what the factory and the product did. Subjects are keyed hashes; message
content is never recorded. Measures (intent completion, revision rate, cost as paid and at today's prices,
distributions) are computed from it, and "not measured" is never shown as zero.

```mermaid
erDiagram
  EVENTS { int seq PK  text at  text kind  text subject "keyed hash"  json data }
  MODEL_CALLS { int seq PK  text at  text model  int input_tokens  int output_tokens  real cost }
  PRICES { text model PK  text effective_from PK  real input_per_mtok  real output_per_mtok  real cached_per_mtok }
  MODEL_CALLS }o--|| PRICES : "priced by"
```

## Verified by

<!-- verified-by:start -->
- [`packages/evidence/test/evidence.test.ts`](../../packages/evidence/test/evidence.test.ts) (6 test definitions)
<!-- verified-by:end -->
