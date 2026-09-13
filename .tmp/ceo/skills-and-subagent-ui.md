# Program: skills duplication and subagent UI parity

## Objective

Determine whether this repository contains avoidable duplicate skills or skill-related inconsistencies, and determine why `spin-box` is rendered as a regular tool call instead of receiving the small subagent-style UI treatment used by the built-in `task` tool. Produce evidence-backed findings and implement fixes only where the cause and scope are clear.

## Tracks

### Track 1 — Skills audit

- **Scope:** Repository skill/config/documentation files and related registration or discovery code; do not modify UI/runtime files owned by Track 2.
- **Authoritative task refs:** User request: inspect the repository for issues involving skills and avoidable duplicate skills.
- **Constraints:** Distinguish intentional aliases/variants from duplicates. Report evidence, impact, and minimal remediation. Do not delete or rename committed skills without explicit confirmation if that changes public behavior.
- **Acceptance:** Inventory relevant skills, identify confirmed avoidable duplicates or explain why apparent duplicates are intentional, and make only approved-safe changes with verification.
- **Status:** Complete (terminal read-only audit by ses_f65b11b45ffe2Z4MKRGIS1O9DP). Findings: No avoidable duplicate skills found. Intentional variants exist (`spin-rnd`, `spin-ops`), loop instructions duplicated across variants. Documentation inconsistencies identified (Pall mentions vs absence in repo, missing spin-box docs, stale line count). Awaiting CEO/User decision on remediation scope.

### Track 2 — `spin-box` UI parity

- **Scope:** Runtime/plugin integration and UI-facing behavior that determines how `spin-box` and built-in `task` calls are represented; do not modify skill inventory files owned by Track 1.
- **Authoritative task refs:** User request: investigate why `spin-box` does not produce the same small button-style subagent UI as built-in `task`, despite that being the goal.
- **Constraints:** Trace the actual event/data path from invocation to UI metadata. Separate repository behavior from host OpenCode behavior and unsupported extension points. Do not assume a code change can control host rendering. Preserve existing tool semantics.
- **Acceptance:** Explain the rendering difference with concrete evidence, identify the smallest viable fix or prove a host limitation, and verify any implementation change.
- **Status:** Closed — terminal verdict: stop without repository changes (Judge review complete in ses_f65b10648ffecrfj0zvsIJLeKN). Host OpenCode 1.18.25 hard-gates the subagent UI component on the literal tool id `task`. No plugin API extension point exists to select renderers or inject custom parts. Parity requires an upstream OpenCode core enhancement.

## Shared resources and ownership

- Repository-wide status and history: shared read-only; each track must avoid altering the other track's files.
- `.tmp/ceo/skills-and-subagent-ui.md`: CEO-owned coordination plan.
- Runtime/plugin files: Track 2 owns.
- Skill/config/documentation files: Track 1 owns.

## Gates retained by CEO

- Any deletion, rename, or behavior-changing skill consolidation.
- Any change requiring host OpenCode changes outside this repository.
- Any cross-track file conflict or incompatible recommendation.
