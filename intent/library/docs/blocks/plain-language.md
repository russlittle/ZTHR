# @zthr/plain-language

Measures whether writing is plain and kind, deterministically, before any model offers a second opinion
(Pattern 19, the determinism ladder). It knows nothing about any one app: the app supplies its own phrase rules.

```mermaid
flowchart LR
  text[Draft text] --> grade[Reading grade: Flesch-Kincaid, names and numbers ignored]
  text --> rules[App phrase rules: scolding, commands]
  text --> care[Carelessness: doubled periods, template holes]
  grade & rules & care --> verdict{Problems}
  verdict -- none --> send[Deliver]
  verdict -- any --> hold[Hold and rewrite]
```

## Use it for

Any text a person will read from an automated system: reading grade against their chosen level, phrase rules for tone, and catching careless output. `sentence()` closes a sentence once, so "5 p.m." never becomes "5 p.m..".

## Not for

Languages other than English for the grade (the formula is English-only; the app records Spanish grade as not measured), judging meaning or accuracy, or translation.

## Verified by

<!-- verified-by:start -->
- [`packages/plain-language/test/plain-language.test.ts`](../../packages/plain-language/test/plain-language.test.ts) (11 test definitions)
<!-- verified-by:end -->
