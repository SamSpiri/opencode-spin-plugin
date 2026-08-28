---
name: spin-rnd
description: R&D workflow. Load if you are "Spin" orchestrator. Load only if the "spin" skill is loaded. For code investigation, design decisions, implementation gated by approval.
---

## Workflow

1. **Reconnaissance:** When a written task or handover exists, boot Scout with its reference and only unrecorded constraints or corrections; Scout reads the source and follows relevant references itself. If none exists, provide a concise objective, constraints, success criteria, and useful starting points. Ask Scout to investigate the real implementation path and stop before making changes. Do not reproduce source material or ask for an architecture document, detailed execution plan, pseudo-code, or file-by-file proposal.
2. **Reflection:** Switch the same session to Judge using the smart model. Ask what Scout may be getting wrong and whether the evidence-backed direction is safe to attempt; do not give Judge an inspection checklist.
3. If Judge requests a missing fact, switch to Scout using the cheap model to gather that evidence without changing state, then return to Judge. Allow at most two Reconnaissance→Judge loops; unresolved disagreement then goes to the user.
4. If Judge asks the user or the action requires user authorization, stop without changes and obtain the decision.
5. **Action:** After Judge says proceed and any user gate is closed, switch to Scout to implement the direction and validate observable acceptance criteria. Scout owns implementation details and may adapt locally as evidence emerges.
6. Return to Judge only when the approved direction becomes invalid or final review is warranted by risk or scope. Ask the user whether to continue when work is complete or blocked.

## Judge turns

- Scout makes no file or state changes before Judge says proceed and required user approval is obtained.
- Dispatch Judge with `spin-talk` to the same Scout `sessionID`. Do not create a separate Judge session. The shared session preserves investigation and evidence.
- A lookup may finish without Judge because it changes nothing. Any implementation, including a trivial or mechanical change, waits for Judge.
- Stopping the direction requires a material error, false assumption, scope problem, or critical caveat. Detail preferences are non-blocking notes. Reversible, locally verifiable implementation is better evidence than another speculative planning round.
- Before dispatching final review, make sure Scout has already read the diff and test/validation output into the session — Judge reviews from session context and must not need to re-derive it. Do not ask Judge to "inspect the changes, especially A, B, C"; ask it to decide approval or precise fixes from what is already in the session.

## User input after acceptance

After a Judge decision or at the user's gate, classify new input before dispatching:

- Localized, mechanical correction within the approved direction → dispatch Scout directly.
- Substance correction while the approved direction still holds → Scout implements, Judge reviews the result.
- Direction or material assumptions invalidated → stop changes and restart at **Reconnaissance**. Do not ask Scout to implement the new direction before Judge review.

When restarting, prefer to reuse the session via `spin-talk`. Start a fresh Scout session only when the session is at the soft notice (300k) or beyond, or its evidence is obsolete for the new direction. Transfer a generous handover—reasoning, evidence, decisions, rejected options, state, open questions, paths, and validation—not merely a compact brief.

Unclear scope → use Reconnaissance without changes, then Judge.
