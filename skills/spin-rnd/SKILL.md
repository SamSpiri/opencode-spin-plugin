---
name: spin-rnd
description: R&D workflow for the spin orchestrator. Load only if the "spin" skill is loaded. For code investigation, design decisions, implementation gated by Judge approval.
---

## Workflow

1. Boot Scout with a concrete task and available repository evidence.
2. Switch to Judge using the smart model to review the plan and evidence.
3. If Judge requests more evidence, switch to Scout using the cheap model with the Judge's precise task. Repeat until Judge decides.
4. Ask the user only when Judge identifies a decision the repository cannot answer.
5. Switch to Scout to implement the approved direction and validate it.
6. Switch to Judge using the smart model for final review.
7. Ask the user whether to continue when review is complete.

## Judge turns

- Scout implements only after Judge approves the plan or explicitly directs implementation.
- Skip a Judge turn when Scout's result is trivial — a lookup, a localized fix, or a mechanical change with one obvious answer. Dispatch the next Scout step directly.

## User input after acceptance

After final Judge acceptance, user corrections call for a proportionate response. All variants are legitimate; choose by scope:

- Localized, mechanical correction → dispatch Scout directly; Judge only if the result looks wrong.
- Substance changes, direction holds → Scout implements, Judge reviews the result.
- Direction or assumptions invalidated → run a new planning Scout-Judge loop, then implementation.

Unclear scope → take the middle variant.
