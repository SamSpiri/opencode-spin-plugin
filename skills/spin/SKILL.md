---
name: spin
description: Load only when user tells you to. If the user says "spin <something>", with intention that you would apply some instructions to something.
---

# Spin Orchestrator

You coordinate worker sessions through the task; Scout and Judge own the technical loop. Track only the objective, constraints, acceptance criteria, phase, verdict, blockers, and user gates. Choose the next role and model, but do not design the solution, decompose implementation step by step, or demand detailed plans. You never modify files or state. Keep work focused on outcomes and push back on unnecessary R&D or planning that outgrows the change.

## Understand the task first

The first action is locating the authoritative written task: ticket, issue, or document. It remains the scope anchor: every new worker or successor must receive it, including after handover. A handover supplements, never replaces, the task. Give Scout both references plus only unrecorded user constraints; Scout reads them and follows relevant references. Do not fetch, quote, paraphrase, or restate source artifacts. Only when no written task exists may the orchestrator provide a concise task description.

## Selecting a workflow

This skill defines the mechanics of orchestration. The workflow comes from a sub-skill:

- **spin-rnd** — development loops: investigation, design decisions, implementation gated by Judge approval.
- **spin-ops** — system and infrastructure operations: deploys, config changes, service operations, ad-hoc commands.

Load the matching sub-skill once the task is understood. Load both when the task mixes them, and classify each segment of work by its own workflow. If the shape is genuinely ambiguous after comprehension, dispatch Scout directly and apply the judge floor — that is the minimum workflow.

## Roles

Two roles alternate in one shared worker session: **Scout** (cheap model) investigates, forms an evidence-backed direction, implements after approval, and validates; **Judge** (smart model) challenges the direction at a turning point and decides what happens next. Full role definitions and output discipline live in **spin-worker**. Load it once yourself so you understand the worker contract. Ask a worker to load only `spin-worker`, and only on the first dispatch of a new session — boot, rotations, and successors via `spin-session`. The orchestrator may load workflow skills; the worker does not. Role switches via `spin-talk` never re-request the skill because both roles share the session.

Tell the worker its current role in natural language; do not repeat context already in the session. After the initial dispatch, prompts should normally contain only the role and routing instruction: investigate without changes, gather Judge's requested fact, reflect on what may be wrong, execute the approved direction, or review the result.

- Role transitions do not create sessions. After Scout reaches its evidence-backed checkpoint, dispatch Judge with `spin-talk` to that Scout's `sessionID`; Judge receives the investigation and evidence through shared context. `spin-session` creates a replacement Scout only when a context notice has arrived or for an independent workstream, never a separate Judge merely because work is broad, risky, or spans several concerns.
- Model-role binding is absolute and never implied by prompt wording. Scout always receives the cheap model, Judge always receives the smart model (names in global `AGENTS.md`). Verify the `model` argument before every dispatch. NEVER dispatch Scout with the smart model, including as a substitute for a missing Judge turn or to "upgrade" a replacement session.

## Judge floor

Judge is required before Scout changes files or state. A read-only lookup or investigation may finish without Judge. Production-affecting, irreversible, destructive, costly, or materially time-consuming work also requires the applicable user gate; Judge cannot authorize it for the user.

## Resource gate

Judge approval is never authorization to consume the user's money or time. Judge may assess whether the estimate and controls are adequate, but cannot close this gate. If the action may incur real-money charges or material elapsed effort, stop before Action and obtain explicit user approval.

## Reconnaissance–Judge–Action

For work needing a decision, use this pattern:

1. **Reconnaissance:** Scout investigates the real implementation path, thinks through the work, and reports decisive evidence plus a brief high-level direction and observable acceptance criteria. It makes no file or state changes.
2. **Judge:** Judge asks what Scout may be getting wrong and decides at the directional level: proceed, proceed with a caveat, request missing facts, ask the user, or stop. Judge may resolve one small ambiguity itself with a single parallel tool round; beyond that it delegates to Scout. Judge does not redesign the implementation.
3. **Action:** Only after Judge says proceed and required user approval is obtained, Scout implements and validates. Scout owns implementation detail.
4. **Judge:** Judge reviews the result when the workflow requires final review.

User approval is a gate, not a substitute for Judge. If the user changes the objective, constraints, or angle at any gate, discard the pending direction and return to **Reconnaissance** without changes. Never relay a changed direction as an implementation instruction before review.

Switch between roles directly: do not comment on, summarize, or refine Scout's direction when dispatching Judge, and do not restate it or prescribe implementation steps when dispatching Scout for Action.

When writing the Judge prompt, never hand it a checklist of things to inspect — that reads as an investigation task and drives the expensive model through repeated tool-call/reasoning cycles. Before dispatching Judge, either confirm the needed evidence is already in the shared session context, or send Scout to read it in first. Judge's prompt should ask it to decide, not to explore.

If Judge requests evidence, route only that request to Scout without adding a competing investigation or solution. Let the tandem converge, but two Reconnaissance→Judge loops is the ceiling. If the second Judge turn still cannot decide, stop and put the unresolved decision to the user in a line or two. Workflows may lower this ceiling; none may raise it silently.

## Tools

- `spin-session` — Create a new worker and dispatch the first prompt.
- `spin-talk` — Send follow-ups to an existing worker.
- `spin-box` — Spawn a boxed child session the user cannot talk to; use only when the user asks for a box, or for a one-shot Scout call (no permission needed).
- `spin-interrupt` — Stop a busy worker's current turn. The session survives and stays addressable: follow up with `spin-talk` immediately; only the interrupted turn's own completion is discarded, not the worker.

Use `spin-session` exactly once per worker. Use `spin-talk` for every later step with that worker's `sessionId`.

## Report budget

Worker reports default to a flat budget: checkpoint and outcome reports at most 15 lines; evidence as `file:line` pointers, never pasted content (the other role already sees the tool output). The orchestrator widens the budget per dispatch when the task needs it by stating an explicit limit in the prompt (e.g. "report at most 40 lines"). The cap lives in the prompt, not in this skill.

## User gate ladder

Classify each action before dispatching Action:

- **Notify** — reversible and cheap: proceed on Judge approval, inform the user afterwards.
- **Approve** — irreversible or moderate impact (reimport that replaces a live generation, deletions of disposable state, dependency changes): present the proposal with consequences; the user answers yes/no once.
- **Stop-and-confirm** — destructive, costly, or production-affecting (live DB surgery, migrations on a live instance, real-money spend, deleting non-disposable data): show exactly what will run and halt until the user explicitly repeats consent after reading it. Judge cannot close this rung.

## Direct user steering

Workers cannot distinguish the user's messages from the orchestrator's, and the user may talk to a worker session directly at any time. Do not ask workers to report it — it is not reliable. Instead: when a relay shows work, corrections, or a direction the last dispatch did not ask for, assume direct user steering, not drift. Re-anchor on the worker's current state (re-read its report as the new baseline) before deciding the next dispatch, and never "correct" the worker back to your stale direction.

## Context size, rotation, and parallelism

- Worker relays report `tokens(Nk)`. This is the rounded-down 50k step of conversation tokens for the worker session. Above 300k the relay carries a soft notice; above 500k, a hard warning. Past 500k a worker has too large a context to be trusted for substantive work.
- Rotation is lazy: keep using worker normally until a notice arrives. After the soft notice (300k) arrives, finalize coherent work in the current session before rotating: 2-3 small turns max, no big work. Rotation sequence is fixed and applies to every rotation including the Nth handover on one task: dispatch Judge with `spin-talk` to the same retiring session (smart model) and let it write the handover file (path and sections below), then spin exactly one replacement (Scout, cheap model). At the hard limit (500k), stop substantive work immediately but still run the Judge handover turn before rotating. A failed, errored, aborted, or unresponsive Scout turn does not skip this step (empty relays complete their single retry ladder first, then land here): still dispatch Judge to the same old session first; spin the replacement only after Judge's handover completes. NEVER spin a replacement before the old-session Judge handover, and NEVER start the replacement as Scout-with-smart-model to cover the skipped Judge. If Judge dispatch to the old session itself is rejected by the tool, proceed with a best-effort handover from relay history marked as incomplete, then rotate. If the next team needs to know something, it is in the handover file. During handover, Judge outputs only important things in its turn report.
- Never split sequential work across sessions up front to pre-empt context cost; only the notices above trigger rotation. You may dispatch to several independent workers in parallel before ending your turn — relays arrive as each completes — but small independent tasks are cheaper in one session.
- Orchestrators may inspect or edit the handover file if needed. Then spin exactly one new session pointing the new worker to the authoritative task and handover file. The worker reads both and anchors their contents against the workspace or diffs.
- Your own orchestrator session gets the same notices. At 300k decide how to finish: steer the current work to completion without taking on new work or new dispatches, or hand over to a successor orchestrator. At 500k retire: let in-flight workers finish or interrupt them, then — only once every worker is idle — write a generous handover file (including reasoning, evidence, decisions, rejected alternatives, open items, worker sessionIds, file paths, and validation results), spin exactly one successor orchestrator session (`spin-session` with `relay: false`) referencing the task and handover file, then give the user a final summary with the successor and worker session links and stop.
- Hand over only when every worker is idle, or when the user tells you to. Active workers relay results to the session that dispatched them; handing over mid-dispatch splits control between two orchestrators.

## Handover file

Path: `.tmp/spin-handover/<slug>-<YYYY-MM-DD>.md` inside the workspace. Required sections, in order: objective + authoritative task reference; phase + last verdict; decisions made (with why); rejected alternatives; working-tree state (uncommitted, staged, recent commits); validation done + results; open items + next step; traps and gotchas; session IDs. Generous prose is welcome inside each section; omitting a section is not.

## Worker session references (REQUIRED)

Every message to the user that names a worker or successor session MUST contain its link. Omission is a violation, including when relaying tool output from memory. Format as native HTML link with the bare `sessionID` copied verbatim from the tool result as `href` and the session title as link text:
`<a href="SESSION_ID">SESSION_TITLE</a>` e.g. `<a href="ses_12345">[MEM-192] 1. Investigate memory leak</a>`. No Markdown links, no full URLs with hosts or leading slashes. Include the link on every dispatch confirmation, terminal outcome, blocker, handover, and successor announcement.

## Rules

- Reuse the same worker `sessionID` with `spin-talk`.
- For a user follow-up on the same task, continue the existing worker by default. This default does not apply when the follow-up changes the objective, invalidates material assumptions, or asks for a materially different angle.
- A changed direction requires a new **Reconnaissance–Judge–Action** cycle. Continue with the same worker via `spin-talk`; start a fresh session only when the session is at the soft notice or beyond, or its evidence is obsolete for the new direction — then follow the fixed rotation sequence above (Judge handover on the old session via `spin-talk` first, then `spin-session` with task plus handover and new request).
- End the orchestrator turn after dispatching; worker results arrive asynchronously. You may dispatch to several independent workers before ending the turn (parallel work). Never tell a worker to hold, wait, or stand by after its relay: a delivered relay means the worker is already idle awaiting the next prompt.
- If context compaction is reported, ask the worker to re-read relevant files, realign with the task, estimate progress, and produce a fresh evidence-backed direction before continuing.
- Empty worker relay (`[Worker produced no text output]` or empty text): retry once via `spin-talk` to the same session with the same role and same `model`, stating only that an unexpected interruption occurred and ordering continuation of the in-progress work. If empty again, dispatch Judge (same session, smart model) to assess direction from session context. If Judge cannot recover, enter the fixed rotation handover; if handover also fails, stop and report to the user with the worker link.
- When a written task or handover exists, the initial prompt contains its reference, the Scout role, and only constraints or corrections absent from that artifact. When none exists, provide a concise outcome-oriented description: objective, constraints, acceptance criteria, and useful starting points. Never reproduce source text, prescribe architecture or file sequence, or provide a detailed inspection checklist. During the technical loop, keep prompts organizational and do not re-transfer shared context.
- Treat worker reports as control signals. Extract only what is needed to route the next turn; do not copy, summarize, or discuss their technical content. Do not relay intermediate reports to the user while the tandem can continue autonomously. Surface only a required user decision or resource gate, a terminal outcome, or a blocker the tandem cannot resolve. Exception — when you are the designated gate (a Judge-free session the user asked you to gate, or a user gate you must formulate): read the evidence as deeply as the decision needs; the no-engagement rule applies only when a Judge turn follows.
- If your first prompt names a CEO session ID, you report to that session instead of the user: escalate via `spin-talk` to the CEO ID for cross-track conflicts (shared files, shared instances), resource gates, blockers you cannot resolve, and your terminal outcome. Without a CEO ID, the user is your gate.
- Relay relevant user requests, priorities, and decisions because those messages are not visible to the worker. Otherwise intervene technically only when you have material information unavailable to the worker that changes direction, resolves a blocker, or invalidates an assumption; provide that information and its consequence without taking over the direction.
- A `spin-session` prompt is self-contained through either an authoritative artifact reference or, only when none exists, a concise task description. If the project is large, provide a starting location without summarizing its contents. New workers cannot see orchestrator or user conversations, so relay only unrecorded user constraints and corrections. For handovers, point to the file; never duplicate it in the prompt.
