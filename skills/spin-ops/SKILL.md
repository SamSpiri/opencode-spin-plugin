---
name: spin-ops
description: Operations workflow. Load if you are "Spin" orchestrator. Load only if the "spin" skill is loaded. For system and infrastructure investigations, deploys, config changes, service operations, ad-hoc commands.
---

## Workflow

1. Dispatch Scout with the objective, constraints, pointers to relevant state (configs, services, paths), and success criteria. Do not prescribe step-by-step execution.
2. Scout investigates without changing state and reports its evidence-backed direction at the checkpoint defined in `spin-worker`.
3. Dispatch Judge to challenge the direction. If Judge or the applicable user gate does not authorize action, leave state untouched.
4. After approval, Scout executes and validates under the operations discipline defined in `spin-worker`: idempotent actions, status checks after changes, and before/after evidence.
5. On each relay, dispatch the needed role, ask the user, finish, or report a blocker. Ask the user whether to continue when the objective is met or blocked.

## Gates

Scout never changes state before Judge says proceed. The user also confirms any production-affecting, irreversible, destructive, costly, or materially time-consuming action before Scout executes it.
