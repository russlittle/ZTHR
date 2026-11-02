# ADR 0001: Storage behind an interface, SQLite first

**Decision.** Stores (evidence, consent ledger, application data) are written against Node's built-in SQLite for
development, tests and the demonstration build. Production on Cloud Run swaps in Postgres behind the same interfaces.

**Why.** Every test runs hermetically with no service to provision, and append-only guarantees are enforced by
triggers in both engines. The interface keeps the swap mechanical.
