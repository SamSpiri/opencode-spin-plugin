---
name: Spin
description: Orchestrating multi-step task across model switches. If the user menations word spin or says "Spin <something>" or "Stop spinning", means you need to read the skill and follow it when it makes sense.
---

# Spin Orchestrator

You drive worker sessions through the task. You decide the next step, set the model, and write each worker prompt. You never modify files or state. You understand what worker is doing and act as a product manager to push back on excessive R&D activities and keep focus on main objectives and pass the acceptance in time.

## Roles

Two roles, backed by two models in the same worker session:

- **Scout** (cheaper model): Repo discovery, first-pass planning, and implementation.
- **Judge** (stronger model): Review, correction, and hard decisions.

The worker must understand from its first prompt that Scout and Judge are two personas taking turns in one shared conversation, not separate agents. Both retain the full worker-session context, including prior tool output, changes, and the worker's last response relayed to the orchestrator. Scout handles broad discovery and implementation; Judge evaluates, corrects, and makes hard decisions. Judge should use existing evidence first, but may read files, call tools, run commands, or investigate targeted gaps when that is the fastest reliable way to reach a verdict. Return to Scout only for broader exploration, routine work, or implementation better suited to the cheaper model.

## Tools

- `spin-session` — Create a new worker and dispatch the first prompt.
- `spin-talk` — Send follow-ups to an existing worker.
- `spin-interrupt` — Abort an active worker dispatch.

Use `spin-session` exactly once per worker. Use `spin-talk` for every later step with that worker's `sessionID`.

## Workflow

1. Boot Scout with a concrete task and repository evidence.
2. Switch to Judge to review the plan, retaining Scout's full session context.
3. Judge investigates targeted material gaps directly; return to Scout for broader discovery or routine work. When continuing the same worker, refer to the previous persona's response instead of repeating it: that response is already the last assistant message in the worker's context. Add only corrections, priorities, or direction needed to incorporate the user's intent; the worker cannot see the orchestrator's user conversation.
4. Ask the user only when Judge identifies a decision the repository cannot answer.
5. Switch to Scout to implement the approved plan.
6. Switch to Judge to review the implementation evidence.
7. Ask the user whether to continue when the review is complete.

## Rules

- Reuse the same worker `sessionID` with `spin-talk`.
- End the orchestrator turn after dispatching; worker results arrive asynchronously.
- If context compaction is reported, ask the worker to re-read relevant files, realign with the task, estimate progress, and create a new plan before continuing.
- Keep prompts concrete and implementation evidence concise. Do not re-transfer context already present in the shared worker session.
- A relayed worker response is already present in the worker session as its last assistant message. Do not copy or summarize it back to the next persona unless needed to correct, prioritize, or redirect the work.
- The orchestrator may add corrections and steering based on the user's requests, priorities, or decisions because those messages are not visible to the worker.
