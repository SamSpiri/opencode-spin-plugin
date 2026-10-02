# Bug: spin retires a dispatch at the first execution end and drops the rest of the work

**Severity:** high — parent coordination silently loses child output.
**Component:** `opencode-spin@2.0.0` (`index.ts`; deployed single-file `~/.config/opencode/plugins/spin.js`, 2026-10-01, same logic).
**Environment:** opencode `v2.0.21`; runtime event contract `@opencode/schema` via `@opencode/plugin@2.0.19`. Note: the `@opencode-ai/sdk` v2 types bundled elsewhere are **not** the plugin's event contract and omit `session.execution.*`.

## Summary

Spin ends a dispatch on the first `session.execution.succeeded` / `session.idle`: it
relays the **latest** assistant message and stops tracking the child. But a
dispatched task can span **several executions**: when the model launches a
background job and yields, the execution ends (succeeded) and the session idles;
the server later auto-continues the same task with a **synthetic** message, with no
new user prompt. Spin relays the pause-time message, removes the dispatch, and
every later message is lost. It also relays only the last assistant message, so
even a correct end-detection would drop earlier text output of a multi-message run.

## Evidence

Child: `ses_f0386637affe3rU4T0hBOW5AhF` ("[WRK] MEM-204 validation: xs then medium").
Parent: `ses_f04064fdeffeku4JnWfkO5wYMC`.
Source: `~/.local/share/opencode/opencode.db`, tables `session_message` (v2 timeline), `session_v2`.

| seq | type | time (UTC) | note |
|----|------|-----------|------|
| 4 | user | 11:57:03 | **only** prompt in the child |
| 5 … 676 | assistant | 11:57–12:06 | recon, infra fix, "Status so far: … xs run executing" |
| **683** | **idle** | **12:06:28** | execution ends while the xs run executes as a **background shell job**; `data.outcome="succeeded"` |
| — | (parent relay) | **12:06:29** | `msg_0fc823f35001aixxX2O402XS7d` — spin relays seq 676 text, `removeActiveDispatch` |
| 686 | synthetic | 12:22:58 | shell job completes, auto-continues same task; `metadata={source:"shell", shellID/jobID:"sh_0fc81588b001fe2Kge4pIlja5D", state:"completed", exit:0}` |
| 687 … 744 | assistant | 12:22:58–12:23:53 | xs results, "medium validation is running" — **never relayed** |
| 751 | idle | 12:23:57 | next execution end (medium run still in progress) |

The 12:06:29 relay is the **last** inbound parent message until the user's next
message (13:08:12): the xs result and medium progress were never delivered.

**Important nuance:** one `user` row does not prove one execution. The auto-
continuation at seq 686 is a second execution of the **same dispatched task**,
started without a new user prompt. The operational failure is the same — spin
declared the dispatched work complete while it still had a continuation.

Bounded queries used (no full scans):
```sql
SELECT seq,type,time_created,substr(data,1,200) FROM session_message
 WHERE session_id='ses_f0386637affe3rU4T0hBOW5AhF' AND type IN ('user','idle','synthetic') ORDER BY seq;
SELECT json_extract(data,'$.outcome') FROM session_message WHERE session_id='…' AND seq=683;
```

## Root cause

1. **Execution end is treated as dispatch end.** `handleEvent` settles on
   `session.idle` or `session.execution.succeeded` (`index.ts:641-671`), then
   `inspectChildResult` removes the dispatch (`index.ts:402`).
   The runtime contract defines `session.execution.started|succeeded|failed|interrupted`
   (`@opencode/schema`, durable, `data:{sessionID}`) and `session.shell.started|ended`,
   `session.synthetic`, `session.status`. A dispatched task may be continued by an
   automatic follow-up execution (synthetic message) after the shell job ends, so a
   single `session.execution.succeeded` is **not** dispatch completion. The plugin
   consumes neither `session.execution.started` nor `session.synthetic`, so it has
   no signal that a continuation is coming; the later end event finds no dispatch.
   `childIdleSettleMs = 600` (`index.ts:123`) only tolerates a sub-second flap.
2. **Only the last assistant message is relayed.** `index.ts:392` selects
   `assistantMessages[len-1]`, `:413` extracts text from it. A run with several
   text messages (seq 5, 28, 253, 339, … 729) loses all but the last.
3. **Delivery failure is unrecoverable (separate defect).** `removeActiveDispatch`
   runs **before** `relayToParent` (`index.ts:402` then `:431`). If the relay
   throws, the catch at `:435` only clears a flag on an already-removed dispatch:
   the result is lost with no retry and no active dispatch.

Minor: `isCompletedAssistantMessage` (`index.ts:235-239`) checks only
`time.created > 0`, not completion.

## Desired behavior

Relay **all** assistant text output produced by the dispatched task (in order,
excluding `reasoning` and tool parts) once the task is genuinely complete — not at
an intermediate execution end.

## Fix direction (candidate, not verified)

- **Define dispatch completion, don't equate it with an execution end.** Needs a
  predicate over execution state + pending continuations + background jobs. The
  team should identify an authoritative signal (server-side if none exists) rather
  than lengthening sleeps. Candidate inputs, each needing verification: does
  `session.status: idle` differ from the deprecated `session.idle`; does a
  `session.execution.started` without a new user prompt mark a continuation; is a
  `session.shell.started` still open at the execution end; is a synthetic
  continuation enqueued before it runs (race risk if settling on job-count=0).
- **Aggregate text by a sequence boundary, not a timestamp.** Record the dispatched
  prompt's admitted message/sequence and relay every completed assistant text part
  after it; preserve chronological order; exclude reasoning/tool parts; never replay
  pre-dispatch or compaction output.
- **Fix delivery ordering:** keep the dispatch until `relayToParent` succeeds; on
  failure, retry or surface an error rather than dropping tracking.
- Define cancellation/interruption/failure behavior explicitly.

## Reproduction

Dispatch a child whose task launches a background shell job mid-run (e.g., a long
dataset/test run) then continues after it. Observe one early relay and silent loss
of later text; DB shows an `idle` row then a `synthetic` shell row in the same
dispatch, with a single `user` row.

## Regression matrix to require

| Case | Expectation |
|------|-------------|
| multi-message run | all assistant text relayed in order, once |
| background-job continuation | no relay until the task truly ends |
| repeated `session.execution.succeeded` / idle | no premature retire, no duplicate relay |
| relay delivery failure | dispatch retained/retried; no silent loss |
| interruption / execution.failed | one error relay, dispatch cleared |
| consecutive dispatches (talk) | no cross-contamination of output |

## Open questions for the plugin/server team

> Resolved by the 2.0.x fix (`index.ts`):
> 1. **No single terminal event exists.** `session.status: idle` and the
>    deprecated `session.idle` are ephemeral and do not account for background
>    jobs, so they do not distinguish pause from terminal. Terminal is the
>    durable `session.execution.succeeded` reached with no pending background
>    obligation and no unconsumed continuation.
> 2. **`session.shell.started/ended` do not fire for the shell tool.** They are
>    emitted only by the `Session.shell` endpoint (`POST /api/session/:id/shell`).
>    Background shell tools instead emit `session.tool.success` with
>    `metadata.status="running"` + `metadata.shellID`, and complete via
>    `session.synthetic` (`metadata.source="shell"`, same `shellID`). There is no
>    `session.background` event; `Job.pendingBackground` is not exposed.
> 3. **No server "no pending continuations" signal.** Spin tracks synthetic
>    continuations and background-tool obligations (recorded on
>    `session.tool.success`, settled only on the matching `session.synthetic`),
>    and waits for the continuation's `session.execution.started`.

1. What event (or combination) marks the **terminal** end of a dispatched task when
   executions auto-continue? Does `session.status: idle` vs the deprecated
   `session.idle` distinguish pause from terminal?
2. Are `session.shell.started/ended` emitted for every background job (ARQ/CLI
   background commands included)?
3. Is there a server-side "no pending continuations" signal, or should spin track
   synthetic/execution-started to debounce?

## Impact

Parent sessions conclude a child is "done" while it is still running and lose the
real results — here the entire xs validation report plus medium progress.
