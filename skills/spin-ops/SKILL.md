---
name: spin-ops
description: Operations workflow. Load if you are "Spin" orchestrator. Load only if the "spin" skill is loaded. For system and infrastructure investigations, deploys, config changes, service operations, ad-hoc commands.
---

## Workflow

1. Dispatch Scout with a concrete task, pointers to the relevant state (configs, services, paths), and success criteria.
2. Scout executes and validates under the operations discipline defined in spin-worker: idempotent actions, status checks after changes, before/after evidence in the relay.
3. On each relay, decide: dispatch the follow-up, finish, escalate to Judge (judge floor), or ask the user.
4. Report the outcome and stop. Ask the user whether to continue when the objective is met or blocked.

## Gates

Dispatch Judge before execution when the judge floor applies. The user confirms any production-affecting, irreversible, or destructive change before Scout executes it.
