# OpenCode Spin

[![npm version](https://img.shields.io/npm/v/opencode-spin.svg)](https://www.npmjs.com/package/opencode-spin)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> Orchestrate OpenCode child sessions across models, agents, and parallel tasks.

Spin gives an OpenCode parent a focused toolset for creating children, continuing them, and stopping them. Child results are relayed back to the parent, so a workflow can move from research to review to implementation without losing the child session.

## Why Spin

- Delegate a task to an isolated child session.
- Switch models or agents between workflow steps.
- Run independent children in parallel.
- Receive completed results asynchronously instead of blocking the parent.
- Interrupt a child that is stuck or no longer useful.
- Recover deliberately when a child's context is compacted.

## Install

**Compatibility:** OpenCode V2, using `@opencode/plugin` `^2.0.18`.

The primary installation path is OpenCode's npm plugin configuration:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-spin"]
}
```

Add this to project or global `opencode.json`, then restart OpenCode. OpenCode installs npm plugins at startup. Spin registers its bundled `spin-lead` skill through V2's skill registry.

### Pin a version

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-spin@2.0.0"]
}
```

### Local development

Build the clone and add its absolute directory to `plugins`:

```bash
npm install
npm run build
```

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/absolute/path/to/opencode-spin"]
}
```

When migrating from V1, remove `~/.config/opencode/plugins/spin.js` and the old copied `spin-*` skill directories from `~/.config/opencode/skills/` before restarting. Do not load V1 and V2 copies together; each has separate in-memory dispatch state.

## The tools

V2 exposes these tools in the `spin` namespace. V1 hyphenated tool names are not registered.

### `tools.spin.session`

Creates a new child session and dispatches its first prompt.

| Argument | Required | Description |
| --- | --- | --- |
| `text` | Yes | Prompt for the child |
| `model` | No | Model in `provider/model` form; omit unless the user names one |
| `agent` | No | Agent name; set only when a specific agent is requested |
| `title` | No | Child title; `[WRK]` is recommended |
| `reportBack` | No | Whether to relay results back to this session (default `true`); set to `false` for successors or detached sessions |
| `wake` | No | Whether dispatching wakes the target into a new turn (default `true`); set to `false` for silent reports |

```text
tools.spin.session({
  "text": "Research the repository and prepare an implementation plan",
  "model": "github-copilot/gpt-5.4-mini",
  "title": "[WRK] Repository research"
})
```

The tool returns immediately with a child session ID. The result arrives later through a parent message.

### `tools.spin.talk`

Sends a follow-up to an existing child. Use this for every subsequent step. Pass the actual session ID returned by Spin, beginning with `ses`; titles and semantic names are not valid IDs.

| Argument | Required | Description |
| --- | --- | --- |
| `sessionID` | Yes | Existing child ID beginning with `ses` |
| `text` | Yes | Follow-up prompt |
| `model` | No | Model in `provider/model` form; omit unless the user names one |
| `agent` | No | Optional agent override |
| `reportBack` | No | Whether to relay results back to this session (default `true`); set to `false` for detached dispatches |
| `wake` | No | Whether dispatching wakes the target into a new turn (default `true`); set to `false` for silent reports |
| `escalate` | No | Wrap the message as an inter-agent report; set `true` only when reporting **up** the hierarchy to a parent/top session (default `false`, never set when talking to child sessions) |

```text
tools.spin.talk({
  "sessionID": "ses_abc123xyz",
  "text": "Now implement the approved plan",
  "model": "openrouter/z-ai/glm-5.2"
})
```

Only one active dispatch may control a child at a time, and a child cannot be controlled by two parent sessions simultaneously.

### `tools.spin.interrupt`

Aborts an active child dispatch:

```text
tools.spin.interrupt({ "sessionID": "ses_abc123xyz" })
```

## A practical workflow

Spin one worker per independent scope; workers run the `advisor` loop in-session:

```text
1. tools.spin.session → worker: "advisor <task>" + task ref, scope, acceptance
2. tools.spin.talk    → same worker on relay: follow-up or next step
```

Each child has its own context. Start separate `tools.spin.session` calls for genuinely parallel work, then continue each with its own `sessionID`.

The bundled `spin-lead` skill defines these orchestration mechanics. Workers activate `advisor` explicitly via the opening `advisor ` line; omit it only for obviously mechanical or low-risk tasks.

### Async relays and turns

Dispatches are asynchronous by default. Spin listens for V2 `session.idle`, `session.execution.failed`, and `session.execution.interrupted` events, reads the completed assistant message, and relays the result to the originating parent. A child can be controlled only after its previous result has been relayed.

### Context compaction recovery

If a child context is compacted during a dispatch, the relay marks that fact. Before continuing, ask the child to re-read the relevant files, realign with the original task, estimate progress, and create a new plan. Compaction may remove substantial working context.

Relays report child context size in 50k-token steps as `tokens(Nk)`. At >300k, relays append a soft notice to prefer fresh child sessions — split into parallel children only when a large amount of remaining work is expected — leaving the mechanics to the parent; at >500k, the notice becomes a hard warning that the child's output is no longer trustworthy and substantive work should move elsewhere. A retiring child may spawn its own successor children and report their sessionIds; those may still be busy at first contact, so `tools.spin.talk` errors are expected until their current task settles.

Parent sessions receive matching notices about their own context — a soft notice at >300k to either steer the current work to completion without new work or new dispatches, or prepare a handover; and a hard warning at >500k to retire — injected silently into the session when the parent goes idle. Retirement writes a generous handover file and spins exactly one successor via `tools.spin.session` with `reportBack: false` referencing that file. Handover happens only when every child is idle — or when the user asks for it — since active children relay results to the session that dispatched them, so handing over mid-dispatch would split control. Handovers are generous — open items, decisions, sessionIds, file paths, reasoning, and validation results — but never pasted file contents.

### Agent discovery

Spin uses OpenCode V2's agent registry to list visible primary agents; it does not scan agent files or parse OpenCode configuration.

## Important limitations

- Active dispatches, ownership, and compaction markers are held in plugin memory. Restarting OpenCode loses that orchestration state; start or recover children again after a restart.
- Reloading the plugin drops its in-memory dispatch tracking; let active child dispatches settle before a reload.
- Child session IDs are required for follow-ups and interrupts.
- A child result can be delayed while OpenCode finishes publishing its completed assistant message.
- Spin is a V2-only plugin and requires `@opencode/plugin` `^2.0.18`.

## Updating

Pin a version in `opencode.json` when reproducibility matters. If OpenCode is holding a stale cached npm installation, restart it first; clearing its package cache is a disruptive last resort.

## Development

```bash
npm install
npm run typecheck
npm run build
npm pack --dry-run
```

`dist/` is generated by the build and is excluded from Git. The project currently has no automated test suite; typecheck, build, and package inspection are the available validation steps.

## License

MIT — see [LICENSE](LICENSE).

<div align="center">

**Not affiliated with Anthropic or OpenCode.**
Independent open-source project.

</div>
