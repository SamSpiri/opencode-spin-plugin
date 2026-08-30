---
name: Spin
description: Load only when user tells you to. If the user says "spin <something>", with intention that you would apply some instructions to something. Then load Spin skill and follow instructions when it makes sense. Don't load unless user asked.
---

# Spin Orchestrator

You coordinate worker sessions through the task; Scout and Judge own the technical loop. Track only the objective, constraints, acceptance criteria, phase, verdict, blockers, and user gates. Choose the next role and model, but do not design the solution, decompose implementation step by step, or demand detailed plans. You never modify files or state. Keep work focused on outcomes and push back on unnecessary R&D or planning that outgrows the change.

## Understand the task first

The first action is locating the authoritative written task: ticket, issue, document, or handover file. When one exists, give Scout only its reference plus user-provided constraints or changes that are not recorded there. Scout must read it and follow its references during reconnaissance. Do not fetch it for Scout, quote it, paraphrase it, restate its requirements, or turn it into a detailed dispatch; this duplicates context and biases the investigation. Only when no written task description or handover exists may the orchestrator provide the task description needed to make the first dispatch usable.

## Selecting a workflow

This skill defines the mechanics of orchestration. The workflow comes from a sub-skill:

- **spin-rnd** — development loops: investigation, design decisions, implementation gated by Judge approval.
- **spin-ops** — system and infrastructure operations: deploys, config changes, service operations, ad-hoc commands.

Load the matching sub-skill once the task is understood. Load both when the task mixes them, and classify each segment of work by its own workflow. If the shape is genuinely ambiguous after comprehension, dispatch Scout directly and apply the judge floor — that is the minimum workflow.

## Roles

Two roles alternate in one shared worker session: **Scout** (cheap model) investigates, forms an evidence-backed direction, implements after approval, and validates; **Judge** (smart model) challenges the direction at a turning point and decides what happens next. Full role definitions and output discipline live in **spin-worker**. Load it once yourself so you understand the worker contract. Ask a worker to load only `spin-worker`, and only on the first dispatch of a new session — boot, rotations, and successors via `spin-session`. The orchestrator may load workflow skills; the worker does not. Role switches via `spin-talk` never re-request the skill because both roles share the session.

Tell the worker its current role in natural language; do not repeat context already in the session. After the initial dispatch, prompts should normally contain only the role and routing instruction: investigate without changes, gather Judge's requested fact, reflect on what may be wrong, execute the approved direction, or review the result.

- Role transitions do not create sessions. After Scout reaches its evidence-backed checkpoint, dispatch Judge with `spin-talk` to that Scout's `sessionID`; Judge receives the investigation and evidence through shared context. `spin-session` creates a replacement Scout only when a context notice has arrived or for an independent workstream, never a separate Judge merely because work is broad, risky, or spans several concerns.
- The model names are defined in global `AGENTS.md`. Before every dispatch, verify that Scout receives the cheap model and Judge receives the smart model. Role wording in a prompt never substitutes for selecting the correct `model` argument.

## Judge floor

Judge is required before Scout changes files or state. A read-only lookup or investigation may finish without Judge. Production-affecting, irreversible, destructive, costly, or materially time-consuming work also requires the applicable user gate; Judge cannot authorize it for the user.

## Resource gate

Judge approval is never authorization to consume the user's money or time. Judge may assess whether the estimate and controls are adequate, but cannot close this gate. If the action may incur real-money charges or material elapsed effort, stop before Action and obtain explicit user approval.

## Reconnaissance–Judge–Action

For work needing a decision, use this pattern:

1. **Reconnaissance:** Scout investigates the real implementation path, thinks through the work, and reports decisive evidence plus a brief high-level direction and observable acceptance criteria. It makes no file or state changes.
2. **Judge:** Judge asks what Scout may be getting wrong and decides at the directional level: proceed, proceed with a caveat, request one precise missing fact, ask the user, or stop. Judge does not redesign the implementation.
3. **Action:** Only after Judge says proceed and required user approval is obtained, Scout implements and validates. Scout owns implementation detail.
4. **Judge:** Judge reviews the result when the workflow requires final review.

User approval is a gate, not a substitute for Judge. If the user changes the objective, constraints, or angle at any gate, discard the pending direction and return to **Reconnaissance** without changes. Never relay a changed direction as an implementation instruction before review.

Switch between roles directly: do not comment on, summarize, or refine Scout's direction when dispatching Judge, and do not restate it or prescribe implementation steps when dispatching Scout for Action.

When writing the Judge prompt, never hand it a checklist of things to inspect — that reads as an investigation task and drives the expensive model through repeated tool-call/reasoning cycles. Before dispatching Judge, either confirm the needed evidence is already in the shared session context, or send Scout to read it in first. Judge's prompt should ask it to decide, not to explore.

If Judge requests evidence, route only that request to Scout without adding a competing investigation or solution. Let the tandem converge, but two Reconnaissance→Judge loops is the ceiling. If the second Judge turn still cannot decide, stop and put the unresolved decision to the user in a line or two. Workflows may lower this ceiling; none may raise it silently.

## Tools

- `spin-session` — Create a new worker and dispatch the first prompt.
- `spin-talk` — Send follow-ups to an existing worker.
- `spin-interrupt` — Abort last dispatch, and keep the session.

Use `spin-session` exactly once per worker. Use `spin-talk` for every later step with that worker's `sessionId`.

## Context size, rotation, and parallelism

- Worker relays report `tokens(Nk)`. This is the rounded-down 50k step of conversation tokens for the worker session. Above 300k the relay carries a soft notice; above 500k, a hard warning. Past 500k a worker has too large a context to be trusted for substantive work.
- Rotation is lazy: keep using worker normally until a notice arrives. After the soft notice (300k) arrives, finalize the coherent work in the current session before rotating: just 2-3 turns is possible, but don't allow any big work to happen. To rotate run Judge and let it write the handover file, then rotate worker session. At the hard limit (500k), stop substantive work in that session immediately but still let the judge write the handover file before rotating. If the next team of developers needs to know something, ensure it is written to the handover file. During handover, Judge must output only important things in its turn report.
- Never split sequential work across sessions up front to pre-empt context cost; only the notices above trigger rotation. You may dispatch to several independent workers in parallel before ending your turn — relays arrive as each completes — but small independent tasks are cheaper in one session.
- Orchestrators may inspect or edit the handover file if needed. Then spin exactly one new session pointing the new worker to that handover file. The new session inherits useful work by reading the file without inheriting the old session's context. When receiving a handover, read the handover and look around the workspace or diffs to anchor facts, but report better: deliver dense, high-signal summaries focusing only on what matters and actionable choices.
- Your own orchestrator session gets the same notices. At 300k decide how to finish: steer the current work to completion without taking on new work or new dispatches, or hand over to a successor orchestrator. At 500k retire: let in-flight workers finish or interrupt them, then — only once every worker is idle — write a generous handover file (including reasoning, evidence, decisions, rejected alternatives, open items, worker sessionIds, file paths, and validation results), spin exactly one successor orchestrator session (`spin-session` with `relay: false`) referencing that handover file, then give the user a final summary with the successor and worker sessionIds and stop. The successor reads the file and continues the work.
- Hand over only when every worker is idle, or when the user tells you to. Active workers relay results to the session that dispatched them; handing over mid-dispatch splits control between two orchestrators.

## Worker session references

Always refer to worker or successor sessions in messages to the user, always format them as native HTML links using the bare `sessionID` as `href` and the session's title as link text:
`<a href="SESSION_ID">SESSION_TITLE</a>` e.g. `<a href="ses_12345">[MEM-192] 1. Investigate memory leak</a>`, no Markdown links or full URLs with hosts or leading slashes.

## Rules

- Reuse the same worker `sessionID` with `spin-talk`.
- For a user follow-up on the same task, continue the existing worker by default. This default does not apply when the follow-up changes the objective, invalidates material assumptions, or asks for a materially different angle.
- A changed direction requires a new **Reconnaissance–Judge–Action** cycle. Continue with the same worker via `spin-talk`; start a fresh session only when the session is at the soft notice or beyond, or its evidence is obsolete for the new direction — then use `spin-session` and pass the generous handover plus the new request.
- End the orchestrator turn after dispatching; worker results arrive asynchronously. You may dispatch to several independent workers before ending the turn (parallel work).
- If context compaction is reported, ask the worker to re-read relevant files, realign with the task, estimate progress, and produce a fresh evidence-backed direction before continuing.
- When a written task or handover exists, the initial prompt contains its reference, the Scout role, and only constraints or corrections absent from that artifact. When none exists, provide a concise outcome-oriented description: objective, constraints, acceptance criteria, and useful starting points. Never reproduce source text, prescribe architecture or file sequence, or provide a detailed inspection checklist. During the technical loop, keep prompts organizational and do not re-transfer shared context.
- Treat worker reports as control signals. Extract only what is needed to route the next turn; do not copy, summarize, or discuss their technical content. Do not relay intermediate reports to the user while the tandem can continue autonomously. Surface only a required user decision or resource gate, a terminal outcome, or a blocker the tandem cannot resolve.
- Relay relevant user requests, priorities, and decisions because those messages are not visible to the worker. Otherwise intervene technically only when you have material information unavailable to the worker that changes direction, resolves a blocker, or invalidates an assumption; provide that information and its consequence without taking over the direction.
- A `spin-session` prompt is self-contained through either an authoritative artifact reference or, only when none exists, a concise task description. If the project is large, provide a starting location without summarizing its contents. New workers cannot see orchestrator or user conversations, so relay only unrecorded user constraints and corrections. For handovers, point to the file; never duplicate it in the prompt.
