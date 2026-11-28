# Agent API: tool reference

Generated from the registry the API serves (`src/agents/tools.ts`). A role sees only its own tools.

| Tool | Kind | Phase | reader | steward | builder | reviewer | operator | triager | pipeline |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `guide` | read | any | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `status` | read | any | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `log` | read | any | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `reading_context` | read | intent | ✓ |  |  |  |  |  |  |
| `reading_submit` | act | intent | ✓ |  |  |  |  |  |  |
| `schematic` | read | intent |  | ✓ | ✓ | ✓ | ✓ | ✓ |  |
| `questions` | read | intent |  | ✓ |  |  |  |  |  |
| `answer_suggest` | propose | intent |  | ✓ |  |  |  |  |  |
| `review` | read | intent |  | ✓ |  | ✓ |  |  |  |
| `release_issue` | act | intent |  | ✓ |  |  |  |  |  |
| `journey_propose` | propose | intent |  | ✓ | ✓ |  |  |  |  |
| `build_plan` | read | build |  |  | ✓ | ✓ |  |  |  |
| `path_tier` | read | build |  |  | ✓ | ✓ |  |  |  |
| `change_open` | act | build |  |  | ✓ |  |  |  |  |
| `checks_run` | act | build |  |  | ✓ |  |  |  |  |
| `defects` | read | build |  |  | ✓ |  |  |  |  |
| `review_queue` | read | review |  |  |  | ✓ |  |  |  |
| `review_packet` | read | review |  |  |  | ✓ |  |  |  |
| `review_submit` | act | review |  |  |  | ✓ |  |  |  |
| `admission` | read | review | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `deploy_plan` | read | deliver |  |  |  |  | ✓ |  | ✓ |
| `deploy_advance` | act | deliver |  |  |  |  | ✓ |  |  |
| `production_request` | propose | deliver |  |  |  |  | ✓ |  |  |
| `deploy_rollback` | act | operate |  |  |  |  | ✓ |  |  |
| `stage_record` | act | deliver |  |  |  |  |  |  | ✓ |
| `watch` | read | operate |  |  |  |  | ✓ |  |  |
| `tickets_list` | read | operate |  |  | ✓ |  |  | ✓ |  |
| `ticket_triage` | act | operate |  |  |  |  |  | ✓ |  |
| `ticket_defect` | act | operate |  |  |  |  |  | ✓ |  |
| `ticket_idea` | propose | operate |  |  |  |  |  | ✓ |  |
| `agenda` | read | any | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `cases` | read | any | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `case_diagnose` | act | build |  |  | ✓ |  |  |  |  |
| `case_confirm` | act | review |  |  |  | ✓ |  |  |  |
| `clarify` | act | intent |  | ✓ |  |  |  |  |  |

## `guide`

How this factory works and what your role does in it: the loop, the rules, your tools and what comes after each. Read it first in every session.

**Then:** Call status to see where the work stands.

_No input._

## `status`

Where the work stands across the whole loop: the intent stage and its open questions, the last released revision, changes in flight and whether each is admitted, delivery, reports waiting, and what is waiting on a person.

**Then:** Pick up the first thing waiting on your role.

_No input._

## `log`

The most recent calls to this API, by every agent, allowed and refused, and whether the hash chain holds.

**Then:** Use it to see what others did before you act on the same work.

| Input | Type | Required | Meaning |
| --- | --- | --- | --- |
| `last` | integer |  | How many entries, newest last (default 20). |

## `reading_context`

The person's rough intent and the reading schema, exactly as every family receives it. Other readings are never shown: a reading is only worth comparing if it is independent.

**Then:** Read it, then call reading_submit with one JSON object in the schema.

_No input._

## `reading_submit`

Submit your reading. It must match the schema exactly and carry your own family; each family reads once. Where it differs from another family, the person is asked.

**Then:** Your part is done. The steward takes it from here.

| Input | Type | Required | Meaning |
| --- | --- | --- | --- |
| `reading` | object | yes | The reading, in the schema reading_context gives. |

## `schematic`

The schematic as the person reads it back: every balloon, its state and tolerance, the title block, and what is still open.

**Then:** Questions and the review show what is left before it can be signed.

_No input._

## `questions`

The open questions, most consequential first, with their choices and what a wrong answer would break.

**Then:** Draft an answer with answer_suggest where the sources settle it; leave the rest for the person.

| Input | Type | Required | Meaning |
| --- | --- | --- | --- |
| `budget` | integer |  | How many to return (default 10). |

## `answer_suggest`

Draft an answer to one open question, with where in the sources it comes from. It is a proposal: the answer counts only when the person signs it.

**Then:** Go on to the next question. The person sees your drafts together and signs or declines each.

| Input | Type | Required | Meaning |
| --- | --- | --- | --- |
| `question` | string | yes | The question id. |
| `answer` | object | yes |  |
| `source` | string | yes | Where in the person’s own words this comes from: the file and the line, quoted. |

## `review`

What the raters found: each person the schematic serves graded on seven axes, mismatches between people and journeys, and the overall grade.

**Then:** Turn what can be fixed from the sources into suggested answers or a journey proposal.

_No input._

## `release_issue`

Issue the next revision of the package from the workspace. After the first, say why. Issuing is not signing: the package says whether it is ready for the person to sign.

**Then:** If it is not ready, the problems say what is left. If it is, tell the person it is ready to sign.

| Input | Type | Required | Meaning |
| --- | --- | --- | --- |
| `reason` | string |  | Why this revision is made. Required after the first. |

## `journey_propose`

Propose a journey card: who walks it, what they are trying to do, what must never happen, and the budget. Agents never lock journeys; a person signs the card into the locked set.

**Then:** Carry on. Until it is signed, the journey judges nothing.

| Input | Type | Required | Meaning |
| --- | --- | --- | --- |
| `id` | string | yes | A short kebab-case id. |
| `persona` | string | yes | Who walks it. |
| `goal` | string | yes | What they are trying to do, in a sentence, with what counts as done. |
| `forbidden` | array | yes | What must never happen on the way. |
| `budget` | object | yes |  |
| `because` | string | yes | What in the schematic, a report or a failure calls for it. |

## `build_plan`

What to build, from the last released revision: the manifest in build order, the gauges that judge it, the starting ratchets, the required checks, and the brief for agents in the package.

**Then:** Build in find-number order on a branch, then call change_open with the commit and the paths you touched.

_No input._

## `path_tier`

The authorship tier of each path, and whether your role may write it. Ask before you edit anything under control/, tools/ or packages/gates/.

**Then:** Leave locked, person and generated paths alone. For a goal you think is wrong, propose a journey.

| Input | Type | Required | Meaning |
| --- | --- | --- | --- |
| `paths` | array | yes | Repository paths. |

## `change_open`

Open a change, before it is pushed. The API first runs the existing typecheck and tests on the base, so a failure already there becomes a case against the base and is never blamed on this change; then on the commit itself. A red commit is refused: nothing red is pushed, opened or reviewed. Also refused if the commit touches a path no agent may write, or one it does not declare. Changes are immutable; to amend, open a new one on the new commit.

**Then:** Push the commit, then call checks_run for the rest of the required checks.

| Input | Type | Required | Meaning |
| --- | --- | --- | --- |
| `title` | string | yes | What it does, in a line. |
| `commit` | string | yes | The full or short git sha. |
| `case` | string |  | The correction case this change fixes, if it is a fix. |
| `base` | string |  | The commit the work starts from; the commit’s parent if left out. |
| `paths` | array | yes | Every path the commit touches. The API checks this against the commit itself. |

## `checks_run`

Run required checks on the change's commit in the factory checkout. The API runs them, cheapest first, stops at the first failure, and records what each process returned; nobody reports a result. A check that passed on the identical tree before is not run again. A failure opens a correction case, or counts as another attempt on the change's case.

**Then:** Fix what failed in a new commit and open a new change; when all pass, wait for reviews.

| Input | Type | Required | Meaning |
| --- | --- | --- | --- |
| `change` | string | yes | The change id. |
| `check` | string: typecheck, person-signed, dependencies, docs, test, gates, journeys, explore, crawl, walk |  | One check; all of them if left out. |
| `all` | boolean |  | Run every check even after one fails (default: stop at the first failure). |

## `defects`

Defects from what people reported: the failing test to write first, what it should expect, and the report it came from.

**Then:** Write the failing test, see it fail, fix it, and open a change whose title names the ticket.

_No input._

## `review_queue`

Changes you may review: written by another family, not yet reviewed by yours, every required check passed, and not blocked by another family. Nothing reaches a model that a machine can still reject.

**Then:** Review the commit itself, against the schematic and the gauges, then call review_submit.

_No input._

## `review_packet`

Everything one review needs and nothing else: the diff of the change (capped), its paths and tiers, and the balloons it builds to. One short call instead of reading the repository.

**Then:** Judge the diff against the balloons and the gauges, then call review_submit.

| Input | Type | Required | Meaning |
| --- | --- | --- | --- |
| `change` | string | yes | The change id. |
| `maxBytes` | integer |  | Cap on the diff (default 40000). |

## `review_submit`

Your verdict on one change. A pass says what you checked; a block names at least one finding. You review a change once per family, and never one your family wrote.

**Then:** Call review_queue for the next.

| Input | Type | Required | Meaning |
| --- | --- | --- | --- |
| `change` | string | yes | The change id. |
| `verdict` | string: pass, block | yes |  |
| `checked` | array | yes | What you checked: each gauge, path or rule you verified, in a line. |
| `findings` | array | yes |  |

## `admission`

Whether a change is admitted, and what is missing or blocking. Computed from the checks the API ran and the reviews recorded; no role can admit a change.

**Then:** The builder fixes what blocks it; reviewers fill the reviews still missing.

| Input | Type | Required | Meaning |
| --- | --- | --- | --- |
| `change` | string | yes | The change id. |

## `deploy_plan`

The delivery stages in order, what each proves and its gate, and where every admitted change stands.

**Then:** Request the next stage with deploy_advance.

_No input._

## `deploy_advance`

Request the next delivery stage for an admitted change. Stages go in order, each after the pipeline has recorded the last as passed. Release to everyone needs a person's approval in production. The pipeline runs the stage under its own identity; you never hold its credentials.

**Then:** Wait for the pipeline to record the result, then request the next stage, or roll back.

| Input | Type | Required | Meaning |
| --- | --- | --- | --- |
| `change` | string | yes | The change id. |
| `stage` | string: build, test, data, package, deploy, canary, release, operate | yes |  |

## `production_request`

Ask a person to approve a change in production, once its canary has passed. Say what the canary showed: the share of people, the time, and every service level against its budget.

**Then:** When it is signed, request the release stage.

| Input | Type | Required | Meaning |
| --- | --- | --- | --- |
| `change` | string | yes | The change id. |
| `evidence` | string | yes | What the canary showed. |

## `deploy_rollback`

Send traffic back to the previous revision, at once. Always allowed: going back is the safe direction. Say why; the change starts delivery again from the first stage when it is fixed.

**Then:** Ask the triager to open a defect for the cause, so it becomes a test and a ratchet.

| Input | Type | Required | Meaning |
| --- | --- | --- | --- |
| `change` | string | yes | The change id. |
| `why` | string | yes | What was seen. |

## `stage_record`

Record what a requested stage proved, with the build that proved it. Only the pipeline records results.

**Then:** The operator requests the next stage.

| Input | Type | Required | Meaning |
| --- | --- | --- | --- |
| `change` | string | yes | The change id. |
| `stage` | string: build, test, data, package, deploy, canary, release, operate | yes |  |
| `ok` | boolean | yes |  |
| `build` | string | yes | The build id. |
| `detail` | string |  | What it proved, or why it failed. |

## `watch`

The service levels the schematic sets: availability, the feedback budget, and each outcome’s target in use, with where each comes from.

**Then:** An alert that burns a budget opens an incident: roll back first, then ask for a defect.

_No input._

## `tickets_list`

What people reported, with where each stands. Their words are shown exactly as written.

**Then:** Triage what is new: set status and severity, mark duplicates, turn bugs into defects and ideas into proposals.

| Input | Type | Required | Meaning |
| --- | --- | --- | --- |
| `status` | string: new, triaged, in progress, resolved, duplicate, not a problem |  |  |

## `ticket_triage`

Set a report's status, severity or note. A duplicate names the report it duplicates; resolved names the evidence: a commit, a test or a revision. What the reporter wrote cannot be changed, and no report is deleted.

**Then:** For a bug, call ticket_defect; for an idea, ticket_idea.

| Input | Type | Required | Meaning |
| --- | --- | --- | --- |
| `ticket` | string | yes | The ticket id. |
| `status` | string: triaged, in progress, resolved, duplicate, not a problem |  |  |
| `severity` | string: critical, high, medium, low |  |  |
| `note` | string |  | A note the reporter sees. |
| `duplicateOf` | string |  | The ticket this one repeats. |
| `evidence` | string |  | For resolved: "commit <sha>", "test <name>" or "revision <n>". |

## `ticket_defect`

Turn a confirmed bug into a defect for builders: the name of the failing test to write first and what it must expect.

**Then:** Builders see it in defects. Resolve the report once the change that fixes it is admitted.

| Input | Type | Required | Meaning |
| --- | --- | --- | --- |
| `ticket` | string | yes | The ticket id. |
| `test` | string | yes | The failing test to write, named for what it proves. |
| `expectation` | string | yes | What the test expects, in a sentence. |

## `ticket_idea`

Carry an idea from a report to the person who holds the intent, as a proposed change to it. The intent changes only if they sign it.

**Then:** Mark the report triaged with a note saying it went to them.

| Input | Type | Required | Meaning |
| --- | --- | --- | --- |
| `ticket` | string | yes | The ticket id. |
| `change` | string | yes | What would change in the intent, in their terms. |

## `agenda`

What is waiting on your role now, most urgent first, and whether spending is paused. A supervisor wakes an agent only when its agenda is not empty, so an idle seat costs nothing.

**Then:** Do the first item. Call agenda again when it is done.

_No input._

## `cases`

Correction cases: every failure the factory saw, its diagnosis, who it waits on, its attempts and whether it is converging.

**Then:** Take the cases waiting on your role.

| Input | Type | Required | Meaning |
| --- | --- | --- | --- |
| `open` | boolean |  | Only cases not closed (default true). |

## `case_diagnose`

Say what caused a failure. bug: the work misses a datum that is clear. intent: the datum is unclear or silent where the work needs it. infeasible: the intent cannot be met as signed. factory: the factory itself is wrong. Anything but a bug names the balloons and is confirmed by a reviewer of another family.

**Then:** For a bug, fix it test first and open a change with this case. Otherwise wait for confirmation.

| Input | Type | Required | Meaning |
| --- | --- | --- | --- |
| `case` | string | yes | The case id. |
| `cause` | string: bug, intent, infeasible, factory | yes |  |
| `balloons` | array |  | The balloons the failure turns on. |
| `evidence` | string | yes | What in the failure shows it: the check output, the finding, the gauge. |

## `case_confirm`

Agree or disagree with a diagnosis that blames the intent or the factory. You must be of another family than the agent that diagnosed it. Disagreeing sends it back as a bug.

**Then:** Call agenda.

| Input | Type | Required | Meaning |
| --- | --- | --- | --- |
| `case` | string | yes | The case id. |
| `agree` | boolean | yes |  |
| `why` | string | yes | What you read in the datum that decides it. |

## `clarify`

Clarify the intent for a confirmed case, with examples and engineering notes only. The API drafts the next revision and compares it with the signed one. Class II (nothing signed is removed, reworded, loosened or re-marked, and no scope is added) is issued at once under the person’s delegation, and the builder goes again. Class I goes to the person with the draft and the reasons.

**Then:** If it was issued, the case waits on the builder. If it was escalated, carry on with other work.

| Input | Type | Required | Meaning |
| --- | --- | --- | --- |
| `case` | string | yes | The case id. |
| `examples` | array |  |  |
| `notes` | array |  | Engineering notes: how, for now. They never change what it must do. |
