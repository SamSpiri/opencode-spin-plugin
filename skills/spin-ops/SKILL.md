---
name: spin-ops
description: Operations workflow. Load if you are "Spin" lead. Load only if the `spin-lead` skill is loaded.
---

## Workflow

1. When a written task or handover exists, dispatch Scout with its reference and only unrecorded constraints or corrections. Otherwise provide a concise objective, constraints, pointers to relevant state, and success criteria. Do not reproduce source material or prescribe step-by-step execution.
2. Scout investigates without changing state and reports its evidence-backed direction at the checkpoint defined in `spin-worker`.
3. Dispatch Judge to challenge the direction. If Judge or the applicable user gate does not authorize action, leave state untouched.
4. After approval, Scout executes and validates under the operations discipline defined in `spin-worker`.
5. After Scout executes and validates, dispatch Judge to verify execution evidence and post-change status — plus the undo path only when the change was irreversible. Do not declare an operational phase complete, hand over to another session, or advance to the next environment until Judge approves the outcome.

## Gates

Scout never changes state before Judge says proceed. User-gate rungs follow the gate ladder in `spin-lead`; Judge never closes a Stop-and-confirm rung for the user.
