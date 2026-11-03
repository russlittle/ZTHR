# Explaining a letter

Letters from agencies, landlords, courts and colleges are where many students first fall behind: the words are
hard and the dates are buried. A student pastes or forwards a letter; the Advocate says who sent it, what it
means, what to do and by when, and offers to put each date on their calendar.

```mermaid
flowchart TD
  in1[Pasted in the app] --> read
  in2[Texted: "explain this letter: ..."] --> read
  in3[Forwarded by email or the API] --> read
  read[Read the letter] --> facts[Extract: sender, kind, every date with what it is for, amounts, phone numbers]
  facts --> plain[Plain explanation made only of those facts]
  plain --> model{A model configured?}
  model -- no --> send[Message with next steps]
  model -- yes --> pre{Crisis words or too long?}
  pre -- yes --> send
  pre -- no --> rewrite[Model rewrites it more warmly]
  rewrite --> post{Every date, amount and phone kept? Nothing added? Passes the tone gate?}
  post -- yes --> warm[Use the rewrite] --> send
  post -- no --> send
  send --> d1[Put each date on my calendar]
  send --> d2[Find help with this]
  send --> d3[Draft a question to the sender]
```

The model never sees a letter with crisis words in it, never decides a fact, and is never the floor: when it is
missing, slow, wrong or unkind, the student gets the plain explanation. Every model call is metered in evidence.

| Kind | What the Advocate says it means |
| --- | --- |
| Eviction notice | It does not mean leaving today; there is a right to a hearing; call Legal Aid |
| Utility shut-off | Service could be cut off; call before the date for a payment plan; apply for HEAP |
| Court | Court dates matter a lot; go, and call Legal Aid |
| Collections | Ask for proof in writing; do not pay or agree yet; get free advice |
| Aid verification | Common, not a sign of anything wrong; send the papers before the date |
| Benefits renewal | Renew or go to the interview so help does not stop |

## Verified by

<!-- verified-by:start -->
- [`apps/advocate/test/letters.test.ts`](../../apps/advocate/test/letters.test.ts) (16 test definitions)
<!-- verified-by:end -->
