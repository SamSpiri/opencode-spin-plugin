---
name: spin-rnd
description: R&D workflow. Load if you are "Spin" orchestrator. Load only if the "spin" skill is loaded. For code investigation, design decisions, implementation gated by approval.
---

## Workflow

1. **Plan:** Boot Scout with a concrete task and available repository evidence.
2. **Judge:** Switch to Judge using the smart model to review the plan and evidence.
3. If Judge requests more evidence, switch to Scout using the cheap model with the Judge's precise task. Repeat until Judge decides.
4. Ask the user only when Judge identifies a decision the repository cannot answer.
5. **Action:** Switch to Scout (same session via `spin-talk`) to implement the approved direction and validate it.
6. Switch to Judge using the smart model for final review.
7. Ask the user whether to continue when review is complete.

## Judge turns

- Scout implements only after Judge approves the plan or explicitly directs implementation.
- After Scout produces a plan, dispatch Judge with `spin-talk` to the same Scout `sessionID`. Do not use `spin-session` for Judge. The shared session preserves the investigation, evidence, and plan; breadth, risk, or multiple concerns are reasons to invoke Judge, not reasons to create a separate Judge session.
- Skip a Judge turn when Scout's result is trivial — a lookup, a localized fix, or a mechanical change with one obvious answer. Dispatch the next Scout step directly.
- Before dispatching final review, make sure Scout has already read the diff and test/validation output into the session — Judge reviews from session context and must not need to re-derive it. Do not ask Judge to "inspect the changes, especially A, B, C"; ask it to decide approval or precise fixes from what is already in the session.

## User input after acceptance

After a Judge decision or at the user's gate, classify new input before dispatching:

- Localized, mechanical correction → dispatch Scout directly; Judge only if the result looks wrong.
- Substance correction while the approved direction still holds → Scout implements, Judge reviews the result.
- Direction or material assumptions invalidated → discard the pending plan and restart at **Plan**. Do not ask Scout to implement the new idea before Judge review.

When restarting, prefer to reuse the session via `spin-talk`. Start a fresh Scout session only when the session is at the soft notice (300k) or beyond, or its evidence is obsolete for the new direction. Transfer a generous handover—reasoning, evidence, decisions, rejected options, state, open questions, paths, and validation—not merely a compact brief.

Unclear scope → take the middle variant.
