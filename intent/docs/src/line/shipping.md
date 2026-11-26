# Shipping

> Move a certified build to the people it is for, stage by stage, with a person approving production and one step back always available.

## TL;DR

A certified build goes to people in {{delivery.stages}} stages ({{delivery.names}}), each with a gate. The operator requests each stage in order; the pipeline runs it under its own identity and records what it proved; a named person approves production after the canary; rolling back is always allowed and takes one step. No one, agent or person, skips a stage.

{{diagram:shipping}}

## Explain it simply

The shelf is delivered to one classroom first. Someone watches it for a day. If it holds, a teacher signs for the whole school, and the rest are delivered. If anything wobbles, the old shelves go back in one trip, and the new one goes back to the shop with a note.

## Engineer

### The stages

{{table:stages}}

### Who does what

| Who | Does | Cannot |
| --- | --- | --- |
| Operator | Requests each stage in order; asks a person to approve production; rolls back | Skip a stage, record a result, or touch credentials |
| Pipeline | Runs each stage under its own identity and records what it proved, with the build id | Request, approve or roll back |
| A named person | Approves production after the canary | Be replaced by a tool |

### Service levels

Every product is held to the service levels its schematic sets, watched from the first canary on. For the worked example: {{shipping.levels}}. A fast burn of any error budget rolls it back first and asks questions after.

### What travels in the package

The delivery pipeline (Cloud Build with verified provenance, image scanning, a software bill of materials and binary authorization), the service definition with a no-traffic tag and canary, the objectives and alerts, and the runbook are all generated into every package, so a product ships the same way as every other.

## Architect

Shipping turns *it passed* into *it is serving*: the system proves that what is running is what passed.

- **Stages are evidence, not ceremony.** Each records a result from the pipeline's own identity; the next cannot be requested until the last is recorded as passed.
- **Approval is narrow.** A person approves production with the canary's evidence in front of them; they are not asked to approve anything a machine can decide.
- **Going back is always one step.** Rollback needs no approval and restarts delivery from the first stage once the fix is admitted.
- **Every product ships the same way.** Generated stages, gates and runbooks make the fleet operable as one, whatever each product does.
- **Agents never hold deployment credentials.** The pipeline acts; agents request and read.
