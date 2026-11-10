# Security

## Reporting a problem

Email **russ@zthr.ai** with what you found, how to reproduce it, and what it could let someone do. Please don't open a public issue for something that could be exploited before it is fixed.

You can expect an acknowledgement within a few days and a plain account of what will be done.

## What is in scope

- **zthr.ai**, the published site and its reference pages.
- **The Student Advocate demonstration** at zthr.ai/studentadvocate, including its admin screens.
- **The source** in this repository and on the `reference-implementation` branch.

The demonstration holds no real student data. Every record is synthetic, and each visitor gets a private sandbox that is discarded after two hours. The college information it shows comes from public sources.

## How the code is defended

The reference application is built by AI agents and admitted by evidence rather than by a person reading the code, so its defences are checks that run on every change: a content security policy that allows only its own origin, no framing by other sites, per-client rate limits, a red-team suite of attacks that must all hold, generated-input fuzzing, and a planted-marker trace that follows every sensitive field through the system and fails the build on any leak. The evidence from each build is published at zthr.ai/reference/factory.
