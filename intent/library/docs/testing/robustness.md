# Robustness: generated inputs, failing services, load and restore

Examples prove what the author thought of. Robustness is about what nobody thought of, so its inputs are
generated, the services fail on purpose, and the load is measured rather than estimated.

```mermaid
flowchart LR
  subgraph gen[Generated input, fast-check]
    t[Any text a student sends]
    f[Any form posted to any screen]
    j[Any JSON sent to the API]
    v[Any action name and argument]
    p[Names every object inherits: constructor, __proto__, valueOf]
  end
  subgraph faults[Campus services fail]
    e[Error 503] --- d[Down] --- g[Garbled JSON] --- m[Empty] --- s[Too slow]
  end
  gen & faults --> app[The Student Advocate]
  app --> never{Never}
  never --> n1[A 500]
  never --> n2[A crash or thrown error]
  never --> n3[undefined, NaN or a stack trace shown to a student]
  never --> n4[An answer with no next step]
  load[Load test: many visitors at once] --> app
  app --> pctl[p50, p95, p99 and errors, published]
```

## What is tested

| Test | What it proves |
| --- | --- |
| Any text | A student can send anything: empty strings, five thousand characters, scripts, SQL, characters outside the basic plane, control characters. Every answer is plain and offers a next step. |
| Any form | Every screen that accepts a form answers below 500 for any fields with any values. |
| Any JSON | Every write route of the integration API answers below 500 for any body, valid JSON or not. |
| Any action | Any action name, including names every JavaScript object inherits, either runs or is refused. |
| Rules for every input | GPA stays between 0 and 4. Pace stays between 0% and 100%. Earned never exceeds attempted. The withdrawal estimate always balances and only grows with time. A course grade stays between its lowest and highest category. |
| Fault matrix | Each of the five campus services fails five ways while three students use every screen and ask about food, buses, rooms, jobs and mentors. Every screen still answers, and every answer says plainly what it can't see. |
| Restore | A snapshot and restore of the whole app gives every student an identical export and consent ledger. |
| Model-based simulation | Weeks of a student's life with the resource guide, as random sequences of up to 40 steps: raise a need, answer a check-in, "not yet", "not today", "it is sorted out", text something, say whether a resource helped, let days pass. After every step the app is compared with a model of what the guide promises (which needs are open, which are paused today, at most three signals, a next step and a passing tone check on every reply). A failure is shrunk to its shortest sequence. See [the resource guide](../flows/resource-guide.md). |
| What students type | A corpus of real phrasings, each routed where it must go (the tonight route, a crisis line, or help for one barrier with the right service first), and phrasings that must not raise the tonight route. |
| Load | `tools/load.ts` sends many visitors at once, each with its own demo copy, through the screens a student uses, and fails on any 500 or a 95th percentile over budget. |

The run count is set by `FUZZ_RUNS`, 200 on every change and more on the nightly run.

## What it found

The generators found three defects that hand-written tests had not:

- **An action named `valueOf` crashed the app.** User text reached the action registry, the draft templates, the
  contact list and the share scopes as a property name, and names every JavaScript object inherits resolved to
  built-in functions. Every lookup keyed by user input now checks that the key is the registry's own.
- **A class name with emoji-range characters crashed a redirect.** Cutting input to a length could split a
  character in half, and the broken half made building the next address throw. User input is now cut by whole
  characters, and any broken character is repaired.
- **A crafted scope name was accepted on a shared link.** The check that a scope exists used `in`, which also
  matches inherited names. A link could be saved with a scope called `toString`, and the student's list of links
  then printed program text. It showed nothing extra, but the check now uses the object's own keys.

Writing the resource guide's tests found three more:

- **"Did it help" answers were never counted.** The answer was recorded with the resource as its subject, and the
  evidence store replaced every subject with a pseudonym, so no record ever matched its resource. The resource is
  now the subject (it is public), and the student appears only as a pseudonym, so each student counts once.
- **"I have nowhere to sleep tonight" was not understood.** It reached the fallback reply. The words students use
  for having no safe place tonight now take the tonight route, from a first text before any sign-up question too.
- **A veterans' center was offered to a student who said she felt alone.** Help meant for one group is now left out
  unless the student said they are in that group.
