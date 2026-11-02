# ADR 0002: Hono server and a framework-free progressive web app

**Decision.** The Advocate's server is Hono on Node; the web app is server-rendered HTML with a small amount of
client script and a web app manifest, installable on phones without an app store.

**Why.** Text parity (PRD P8) means the server must hold all behavior; the web view is a renderer of the same
state the text channel uses. A small, framework-free surface keeps journeys fast, accessible-name locators stable,
and the dependency footprint the review panel must read small.
