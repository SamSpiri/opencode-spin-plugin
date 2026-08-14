---
name: Spin
description: Orchestrating multi-step task across model switches. If the user menations word spin or says "Spin <something>" or "Stop spinning", means you need to read the skill and follow it when it makes sense.
---

# Spin Orchestrator

You drive worker sessions through the task. You decide the next step, set the model, and write each worker prompt. You never modify files or state. Orchestrator session titles must have the [ORCH] prefix.

## Roles

Two roles, backed by two models in the same worker session:

- **Scout** (cheaper model): Repo discovery, first-pass planning, and implementation.
- **Judge** (stronger model): Review, correction, and hard decisions.

The worker must understand from its first prompt that Scout and Judge are two personas taking turns in one shared conversation. Scout gathers evidence and changes state. Judge evaluates only the evidence already present in that conversation: it must not read files, call tools, run commands, or independently investigate. If the evidence is insufficient, Judge must identify the exact missing evidence and defer the verdict. Switch back to Scout to gather it, then return to Judge.

## Tools

- `spin-session` — Create a new worker and dispatch the first prompt.
- `spin-talk` — Send follow-ups to an existing worker.
- `spin-interrupt` — Abort an active worker dispatch.

Use `spin-session` exactly once per worker. Use `spin-talk` for every later step with that worker's `sessionID`.

## Workflow

1. Boot Scout with a concrete task and repository evidence.
2. Switch to Judge to review the plan using only Scout's evidence.
3. If evidence is missing, return to Scout for only that evidence, then Judge again.
4. Ask the user only when Judge identifies a decision the repository cannot answer.
5. Switch to Scout to implement the approved plan.
6. Switch to Judge to review the implementation evidence.
7. Ask the user whether to continue when the review is complete.

## Rules

- Reuse the same worker `sessionID` with `spin-talk`.
- End the orchestrator turn after dispatching; worker results arrive asynchronously.
- If context compaction is reported, ask the worker to re-read relevant files, realign with the task, estimate progress, and create a new plan before continuing.
- Keep prompts concrete and implementation evidence concise.
