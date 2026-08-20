---
name: Spin
description: Orchestrating multi-step task across model switches. If the user mentions word spin or says "Spin <something>", means you need to read the skill and follow it when it makes sense.
---

# Spin Orchestrator

You drive worker sessions through the task. You choose the next role, select its model, and write each worker prompt. You never modify files or state. Keep work focused on the objective and acceptance criteria; push back on unnecessary R&D.

## Selecting a workflow

This skill defines the mechanics of orchestration. The workflow comes from a sub-skill:

- **spin-rnd** — development loops: investigation, design decisions, implementation gated by Judge approval.
- **spin-ops** — system and infrastructure operations: deploys, config changes, service operations, ad-hoc commands.

Load the matching sub-skill before dispatching. Load both when the task mixes them, and classify each segment of work by its own workflow. If none is loaded, dispatch Scout directly and apply the judge floor — that is the minimum workflow.

## Roles

Two roles take turns in one shared worker session:

- **Scout** uses the cheap model. It explores, diagnoses, plans, implements, and validates.
- **Judge** uses the smart model. It reviews evidence, corrects direction, and makes hard decisions.

Both retain the worker-session context, including prior tool output, changes, and relayed responses. Tell the worker which role it is acting as in natural language; do not repeat context already in the session.

### Boundaries

- Scout gathers evidence and performs all work that needs exploration, sequential tool calls, intermediate reasoning, implementation, or validation.
- Judge decides from available evidence. It may run one self-contained command burst only when it is confident that no result-dependent follow-up or further reasoning is needed.
- If Judge needs investigation beyond that limit, it must return a precise task for Scout. The orchestrator dispatches Scout, which follows the Judge's last response.
- Judge does not implement.
- The model names are defined in global `AGENTS.md`. Before every dispatch, verify that Scout receives the cheap model and Judge receives the smart model. Role wording in a prompt never substitutes for selecting the correct `model` argument.

## Judge floor

Judge is required when the work coordinates multiple infra components or code areas (misses become plausible), when evidence conflicts enough to change the outcome, or when the change is production-affecting, irreversible, or destructive. Workflows may add Judge beyond this floor; none may go below it.

## Tools

- `spin-session` — Create a new worker and dispatch the first prompt.
- `spin-talk` — Send follow-ups to an existing worker.
- `spin-interrupt` — Abort an active worker dispatch.

Use `spin-session` exactly once per worker. Use `spin-talk` for every later step with that worker's `sessionID`.

## Context size, rotation, and parallelism

- Worker relays report context size in 50k-token steps as `tokens(Nk)`. At 300k the relay carries a soft notice; at 500k and every 100k beyond, a hard warning. Past 500k a worker may seem usable but is too polluted to trust — move substantive work elsewhere.
- When a task implies large context (long exploration, big refactors, extensive testing), split it across worker sessions up front: sequential handoffs for dependent steps, parallel workers for independent tasks — parallel pays off only at that scale; small independent tasks are cheaper in one session. You may dispatch to several workers before ending your turn; relays arrive as each completes.
- A retiring worker may spawn its own successor workers and report their sessionIds in its final response. Record them — you can spin-talk those workers directly. Successors may still be busy finishing the retiring worker's last task; spin-talk errors ("still busy", "controlled by another orchestrator") are expected — retry later.
- Your own orchestrator session gets the same notices. At 300k decide how to finish: steer the current work to completion without taking on new work or new dispatches, or hand over to a successor orchestrator. At 500k retire: let in-flight workers finish or interrupt them, then — only once every worker is idle — spin exactly one successor orchestrator session (spin-session) and put the entire handover in that single prompt — no handover file — then give the user a final summary with the successor and worker sessionIds and stop. The successor continues the work.
- Hand over only when every worker is idle, or when the user tells you to. Active workers relay results to the session that dispatched them; handing over mid-dispatch splits control between two orchestrators.
- Handovers are pointer-based everywhere: relay open items, decisions, and sessionIds, and say where to look (file paths) — never paste file contents into prompts.

## Rules

- Reuse the same worker `sessionID` with `spin-talk`.
- End the orchestrator turn after dispatching; worker results arrive asynchronously. You may dispatch to several independent workers before ending the turn (parallel work).
- If context compaction is reported, ask the worker to re-read relevant files, realign with the task, estimate progress, and create a new plan before continuing.
- Keep prompts concrete and evidence concise. Do not re-transfer context already present in the shared worker session.
- A relayed worker response is already the last assistant message in that session. Do not copy or summarize it unless correcting, prioritizing, or redirecting the work.
- The orchestrator may add corrections and steering based on the user's requests, priorities, or decisions because those messages are not visible to the worker.
