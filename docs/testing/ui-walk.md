# Walking in a real browser

The browser walk drives the app by accessible names only, the way a person with a screen reader would, and reads
every stop twice: as structure (accessibility rules, headings, tap targets, no sideways scrolling) and as pixels
(screenshots). The intent part records video.

```mermaid
flowchart TD
  subgraph one[Part one: intents with video]
    a1[Start] --> a2[Maria's day] --> a3[Draft to landlord] --> a4[Sent] --> a5[Money] --> a6[Power shut-off] --> a7[You] --> a8[Week]
  end
  subgraph two[Part two: every screen]
    s[3 students x 10 screens x phone and desktop x light and dark]
  end
  one & two --> inspect{At every stop}
  inspect --> axe[No serious or critical accessibility violation]
  inspect --> h1[Exactly one h1]
  inspect --> tap[Tap targets at least 44 px]
  inspect --> side[No sideways scroll]
  inspect --> shot[Screenshot]
  shot --> manifest[(manifest.json for the factory console)]
```

## Verified by

<!-- verified-by:start -->
- [`tools/test/ui-walk.test.ts`](../../tools/test/ui-walk.test.ts) (3 test definitions)
<!-- verified-by:end -->
