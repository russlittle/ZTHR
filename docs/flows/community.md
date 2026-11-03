# Community

Students can ask for and offer help, share tips, and find study partners, inside communities they choose. Nothing
is posted under a real name; posts expire; anything risky is held for a person before anyone sees it.

```mermaid
flowchart TD
  post[Ask, offer or tip] --> mod{Moderation filters}
  mod -- phone numbers, links, drugs, threats, money first --> queue[(Held for a person)]
  mod -- clean --> visible[Visible to the same college and chosen communities]
  visible --> match{An offer meets an ask?}
  match -- both approve --> connect[Connected, by pseudonym]
  visible --> expire[Closes when met or expired]
  tips[Tips] --> rate[Rated by students] --> retire[Retired when stale or unhelpful]
  course[Three students in a course] --> group[Study group forms]
```

## Verified by

<!-- verified-by:start -->
- [`apps/advocate/test/community.test.ts`](../../apps/advocate/test/community.test.ts) (7 test definitions)
<!-- verified-by:end -->
