# Signing in

In the demonstration anyone can open the twelve students. In production, a student signs in with Google, and
every page of their Advocate needs their own session. The admin needs an email on the admin list. The server
trusts nothing in a Google token until it has checked all of it.

```mermaid
sequenceDiagram
  actor S as Student
  participant B as Browser
  participant G as Google
  participant A as Advocate
  participant E as Egress block
  S->>B: Sign in with Google
  B->>G: Google sign-in
  G-->>B: ID token (signed JWT)
  B->>A: POST /auth/google: token + anti-forgery value
  A->>A: anti-forgery cookie matches?
  A->>E: Google's current keys (www.googleapis.com only)
  E-->>A: keys
  A->>A: RS256 signature, issuer, audience, expiry, issue time, verified email
  A->>A: keyed hash of the Google subject: find or make the student's record
  A-->>B: session cookie (signed by the server, 12 hours)
  B->>A: /s/{id}
  A->>A: session owns this record?
  A-->>S: their Advocate
```

| Refused | Why |
| --- | --- |
| Any algorithm but RS256, including `none` and HS256 | Algorithm confusion is a classic forgery |
| A key id Google has not published | Only Google's keys sign |
| A token for another app, another issuer, expired or from the future | The token must be for this app, now |
| An unverified email | The account must be real |
| A missing or mismatched anti-forgery value | Stops sign-in forgery from another site |
| Google's keys unreachable | Refuse rather than trust |

The record stores only a keyed hash of the Google subject; the session carries that hash and a hash of the email,
nothing else.

## Verified by

<!-- verified-by:start -->
- [`apps/advocate/test/auth.test.ts`](../../apps/advocate/test/auth.test.ts) (15 test definitions)
<!-- verified-by:end -->
