# Deadlines, plans and held time

```mermaid
flowchart LR
  syl[Syllabus text] --> parse[Find every date + the AI policy line]
  ics[Calendar feed] --> parse
  api[API: deadlines] --> dl
  parse --> unconf[Unconfirmed dates] --> review{Student checks}
  review -- looks right --> dl[(Deadlines)]
  review -- remove --> gone[Removed]
  dl --> today[Today: one thing to do]
  dl --> ahead{Due within effort-based lead time?}
  ahead -- yes --> card[Card: open two hours + hold it]
  card -- hold --> hold[(Held time + reminder)]
  card -- steps --> steps[Small steps placed in open time] -- put on calendar --> hold
  ahead -- passed --> recover[Recovery: draft to the instructor]
  hold --> feed[Calendar feed .ics]
```

Lead time grows with effort: `ceil(effort hours / 2) + 1` days, raised two days before that. Readings that pass get
no recovery note. Re-uploading a syllabus never duplicates a date.

## Verified by

<!-- verified-by:start -->
- [`apps/advocate/test/domain.test.ts`](../../apps/advocate/test/domain.test.ts) (14 test definitions)
- [`apps/advocate/test/phase1-extras.test.ts`](../../apps/advocate/test/phase1-extras.test.ts) (8 test definitions)
<!-- verified-by:end -->
