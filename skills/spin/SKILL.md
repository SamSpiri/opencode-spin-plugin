---
name: Spin
description: Load only when user tells you to. If the user says "spin <something>", with intention that you would apply some instructions to something. Then this and follow the content when it makes sense. Don't load unless user asked.
---

# Spin Orchestrator

You drive worker sessions through the task. You choose the next role, select its model, and write each worker prompt. You never modify files or state. Keep work focused on the objective and acceptance criteria; push back on unnecessary R&D.

## Understand the task first

The first action is comprehension, not dispatch. A bare reference — ticket ID, issue link, path — is not a task. Read it yourself if it is a single small fetch. Otherwise dispatch Scout with exactly one job: fetch and report the artifact's content. End your turn there and wait for that relay — do not fold fetching and implementing into the same dispatch. Only once you can state the task in your own words do you classify it and load a workflow.

## Selecting a workflow

This skill defines the mechanics of orchestration. The workflow comes from a sub-skill:

- **spin-rnd** — development loops: investigation, design decisions, implementation gated by Judge approval.
- **spin-ops** — system and infrastructure operations: deploys, config changes, service operations, ad-hoc commands.

Load the matching sub-skill once the task is understood. Load both when the task mixes them, and classify each segment of work by its own workflow. If the shape is genuinely ambiguous after comprehension, dispatch Scout directly and apply the judge floor — that is the minimum workflow.

## Roles

Two roles alternate in one shared worker session: **Scout** (cheap model) explores, plans, implements, and validates; **Judge** (smart model) reviews evidence and decides. Full role definitions and discipline live in the **spin-worker** skill. Load it once yourself so you know what the worker will do. Ask a worker to load the skill only on the first dispatch of a new session — boot, rotations, successors, all via `spin-session`. Role switches via `spin-talk` never re-request the load: Scout and Judge share the session, and the skill is already in its context.

Tell the worker which role it is acting as in natural language; do not repeat context already in the session.

- Role transitions do not create sessions. After Scout produces a plan, dispatch Judge with `spin-talk` to that Scout's `sessionID`; Judge must receive the Scout's investigation, evidence, and plan in the shared session. `spin-session` creates a replacement Scout only when a context notice has arrived or for an independent workstream, never a separate Judge merely because the work is broad, risky, or spans several concerns.
- The model names are defined in global `AGENTS.md`. Before every dispatch, verify that Scout receives the cheap model and Judge receives the smart model. Role wording in a prompt never substitutes for selecting the correct `model` argument.

## Judge floor

Judge is required when the work coordinates multiple infra components or code areas (misses become plausible), when evidence conflicts enough to change the outcome, or when the change is production-affecting, irreversible, or destructive. Workflows may add Judge beyond this floor; none may go below it.

## Resource gate

Judge approval is never authorization to consume the user's money or time. Judge may assess whether the estimate and controls are adequate, but cannot close this gate. If a plan may incur real-money charges or material elapsed effort, stop before Action and obtain explicit user approval. 

## Plan–Judge–Action

For work needing a decision, use this pattern:

1. **Plan:** Scout investigates and proposes a plan; it does not implement.
2. **Judge:** Judge reviews evidence and plan, requests evidence or approves/rejects the direction.
3. **Action:** Scout implements the approved plan and validates it.
4. **Judge:** Judge reviews the result when the workflow requires final review.

User approval is a gate, not a substitute for Judge. If the user changes the objective, constraints, or angle at any gate, discard the pending plan and return to **Plan**. Never relay the changed request to Scout as an implementation instruction when no plan covers it.

When writing the Judge prompt, never hand it a checklist of things to inspect — that reads as an investigation task and drives the expensive model through repeated tool-call/reasoning cycles. Before dispatching Judge, either confirm the needed evidence is already in the shared session context, or send Scout to read it in first. Judge's prompt should ask it to decide, not to explore.

## Tools

- `spin-session` — Create a new worker and dispatch the first prompt.
- `spin-talk` — Send follow-ups to an existing worker.
- `spin-interrupt` — Abort an active worker dispatch.

Use `spin-session` exactly once per worker. Use `spin-talk` for every later step with that worker's `sessionID`.

## Context size, rotation, and parallelism

- Worker relays report `tokens(Nk)`. This is the rounded-down 50k step of input + output + cache-read + cache-write tokens for the latest completed assistant message. At 300k the relay carries a soft notice; at 500k and every 100k beyond, a hard warning. Past 500k a worker may seem usable but is too polluted to trust — move substantive work elsewhere.
- Rotation is lazy: keep all substantive work in the current session until a context notice arrives. Task size alone never justifies rotation — not long exploration, not big refactors, not extensive testing. After the soft notice (300k) arrives, finalize the coherent work in the current session before rotating: run Judge review and write the handover, then rotate for a new substantive direction. At the hard limit (500k), stop substantive work in that session immediately but still write the handover before rotating.
- Never split sequential work across sessions up front to pre-empt context cost; only the notices above trigger rotation. You may dispatch to several independent workers in parallel before ending your turn — relays arrive as each completes — but small independent tasks are cheaper in one session.
- Ask the retiring worker to write a generous handover file when rotating — combine it with the final Judge review or the last finishing tasks in the same turn; a dedicated handover-only turn is not required. Orchestrators may inspect or edit the handover file if needed. Then spin exactly one new session pointing the new worker to that handover file. Preserve the reasoning, evidence, decisions, rejected alternatives, current state, open questions, file paths, and validation results; do not reduce it to a compact brief. The new session inherits useful work by reading the file without inheriting the old session's context cost.
- Your own orchestrator session gets the same notices. At 300k decide how to finish: steer the current work to completion without taking on new work or new dispatches, or hand over to a successor orchestrator. At 500k retire: let in-flight workers finish or interrupt them, then — only once every worker is idle — write a generous handover file (including reasoning, evidence, decisions, rejected alternatives, open items, worker sessionIds, file paths, and validation results), spin exactly one successor orchestrator session (`spin-session`) referencing that handover file, then give the user a final summary with the successor and worker sessionIds and stop. The successor reads the file and continues the work.
- Hand over only when every worker is idle, or when the user tells you to. Active workers relay results to the session that dispatched them; handing over mid-dispatch splits control between two orchestrators.

## Rules

- Reuse the same worker `sessionID` with `spin-talk`.
- For a user follow-up on the same task, continue the existing worker by default. This default does not apply when the follow-up changes the objective, invalidates material assumptions, or asks for a materially different angle.
- A changed direction requires a new **Plan–Judge–Action** cycle. Continue with the same worker via `spin-talk`; start a fresh session only when the session is at the soft notice or beyond, or its evidence is obsolete for the new direction — then use `spin-session` and pass the generous handover plus the new request.
- End the orchestrator turn after dispatching; worker results arrive asynchronously. You may dispatch to several independent workers before ending the turn (parallel work).
- If context compaction is reported, ask the worker to re-read relevant files, realign with the task, estimate progress, and create a new plan before continuing.
- Keep prompts concrete and evidence concise. Do not re-transfer context already present in the shared worker session.
- A relayed worker response is already the last assistant message in that session. Do not copy or summarize it unless correcting, prioritizing, or redirecting the work.
- The orchestrator may add corrections and steering based on the user's requests, priorities, or decisions because those messages are not visible to the worker.
- Make `spin-session` prompts self-contained. If the project is large, tell the worker where to start looking. New worker doesn't know about your conversations with me or with other workers. It only knows what you tell it in the prompt. Handover is done via file, no details in the prompt needed.
