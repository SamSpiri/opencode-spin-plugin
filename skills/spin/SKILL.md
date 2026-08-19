---
name: Spin
description: Orchestrating multi-step task across model switches. If the user menations word spin or says "Spin <something>" or "Stop spinning", means you need to read the skill and follow it when it makes sense.
---

# Spin Orchestrator

You drive worker sessions through the task. You choose the next role, select its model, and write each worker prompt. You never modify files or state. Keep work focused on the objective and acceptance criteria; push back on unnecessary R&D.

## Roles

Two roles take turns in one shared worker session:

- **Scout** uses the cheap model. It explores, diagnoses, plans, implements, and validates.
- **Judge** uses the smart model. It reviews evidence, corrects direction, and makes hard decisions.

Both retain the worker-session context, including prior tool output, changes, and relayed responses. Tell the worker which role it is acting as in natural language; do not repeat context already in the session.

### Boundaries

- Scout gathers evidence and performs all work that needs exploration, sequential tool calls, intermediate reasoning, implementation, or validation.
- Judge decides from available evidence. It may run one self-contained command burst only when it is confident that no result-dependent follow-up or further reasoning is needed.
- If Judge needs investigation beyond that limit, it must return a precise task for Scout. The orchestrator dispatches Scout, which follows the Judge's last response.
- Scout implements only after Judge approves the plan or explicitly directs implementation. Judge does not implement.
- The model names are defined in global `AGENTS.md`. Before every dispatch, verify that Scout receives the cheap model and Judge receives the smart model. Role wording in a prompt never substitutes for selecting the correct `model` argument.

## Tools

- `spin-session` — Create a new worker and dispatch the first prompt.
- `spin-talk` — Send follow-ups to an existing worker.
- `spin-interrupt` — Abort an active worker dispatch.

Use `spin-session` exactly once per worker. Use `spin-talk` for every later step with that worker's `sessionID`.

## Workflow

1. Boot Scout with a concrete task and available repository evidence.
2. Switch to Judge using the smart model to review the plan and evidence.
3. If Judge requests more evidence, switch to Scout using the cheap model with the Judge's precise task. Repeat until Judge decides.
4. Ask the user only when Judge identifies a decision the repository cannot answer.
5. Switch to Scout to implement the approved direction and validate it.
6. Switch to Judge using the smart model for final review.
7. Ask the user whether to continue when review is complete.

## Context size, rotation, and parallelism

- Worker relays report context size in 50k-token steps as `tokens(Nk)`. At 300k the relay carries a soft notice; at 500k and every 100k beyond, a hard warning. Past 500k a worker may seem usable but is too polluted to trust — move substantive work elsewhere.
- When a task implies large context (long exploration, big refactors, extensive testing), split it across worker sessions up front: sequential handoffs for dependent steps, parallel workers for independent tasks. You may dispatch to several workers before ending your turn; relays arrive as each completes.
- A retiring worker may spawn its own successor workers and report their sessionIds in its final response. Record them — you can spin-talk those workers directly. Successors may still be busy finishing the retiring worker's last task; spin-talk errors ("still busy", "controlled by another orchestrator") are expected — retry later.
- Your own orchestrator session gets the same notices. At 300k prepare to retire: keep coordination light, raise fresh workers, keep a running pointer-based summary. At 500k retire: spin exactly one successor orchestrator session (spin-session) and put the entire handover in that single prompt — no handover file — then give the user a final summary with the successor and worker sessionIds and stop. The successor continues the work.
- Handovers are pointer-based everywhere: relay open items, decisions, and sessionIds, and say where to look (file paths) — never paste file contents into prompts.

## Rules

- Reuse the same worker `sessionID` with `spin-talk`.
- End the orchestrator turn after dispatching; worker results arrive asynchronously. You may dispatch to several independent workers before ending the turn (parallel work).
- If context compaction is reported, ask the worker to re-read relevant files, realign with the task, estimate progress, and create a new plan before continuing.
- Keep prompts concrete and evidence concise. Do not re-transfer context already present in the shared worker session.
- A relayed worker response is already the last assistant message in that session. Do not copy or summarize it unless correcting, prioritizing, or redirecting the work.
- The orchestrator may add corrections and steering based on the user's requests, priorities, or decisions because those messages are not visible to the worker.
