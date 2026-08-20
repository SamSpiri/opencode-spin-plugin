---
name: spin-ops
description: Operations workflow for the spin orchestrator. Load after the spin skill for system and infrastructure work — deploys, config changes, service operations, ad-hoc commands. Judge is gated by the judge floor, not default. For development loops use spin-rnd.
---

# Spin Ops Workflow

Requires the spin skill — load it first if it is not in context. Roles, tools, judge floor, and session rules are defined there.

## Workflow

1. Dispatch Scout with a concrete task, pointers to the relevant state (configs, services, paths), and success criteria.
2. Scout executes and validates: prefer idempotent actions, check status after changes, include before/after evidence in the relay.
3. On each relay, decide: dispatch the follow-up, finish, escalate to Judge (judge floor), or ask the user.
4. Report the outcome and stop. Ask the user whether to continue when the objective is met or blocked.

## Gates

Dispatch Judge before execution when the judge floor applies. The user confirms any production-affecting, irreversible, or destructive change before Scout executes it.
