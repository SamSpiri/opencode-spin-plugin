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

**Compatibility:** the package declares `@opencode-ai/plugin` `^0.15.18`. Node.js `>= 20` is required for the development/advanced installer path.

The primary installation path is OpenCode's npm plugin configuration:

```json
{
  "plugin": ["opencode-spin"]
}
```

Add this to `opencode.json` in a project or to `~/.config/opencode/opencode.json`, then restart OpenCode. OpenCode installs npm plugins at startup. Spin automatically exposes its bundled `spin-lead`, `spin-head`, `spin-worker`, `spin-rnd`, and `spin-ops` skills through the plugin; no separate skill installation is required.

### Pin a version

```json
{
  "plugin": ["opencode-spin@1.0.0"]
}
```

### Advanced: install the plugin and skills from a clone

Use this path only when you need a local/global plugin copy instead of the npm installation:

```bash
git clone https://github.com/SamSpiri/opencode-spin-plugin.git
cd opencode-spin-plugin
npm install
npm run install:opencode
```

The installer is repository-root based and must be run from the clone. It:

- copies the built plugin to `~/.config/opencode/plugins/spin.js`;
- copies `skills/{spin-lead,spin-head,spin-worker,spin-rnd,spin-ops}/SKILL.md` to global OpenCode skill directories;
- adds runtime dependencies to `~/.config/opencode/package.json` when absent;
- removes matching legacy `kanrisha`/`knr` plugin entries and files, plus the renamed `spin`/`head` skill directories, to prevent duplicate instances;
- removes the legacy `~/.config/opencode/skills/knr` directory.

These are global configuration and filesystem changes. Review them before running the command, and restart OpenCode afterward. Do not combine this local plugin copy with an npm plugin entry for Spin: duplicate instances split in-memory dispatch state.

## The tools

### `spin-session`

Creates a new child session and dispatches its first prompt.

| Argument | Required | Description |
| --- | --- | --- |
| `text` | Yes | Prompt for the child |
| `model` | Yes | Model in `provider/model` form, such as `github-copilot/gpt-5.4-mini` |
| `agent` | No | Agent name; set only when a specific agent is requested |
| `title` | No | Child title; `[WRK]` is recommended |
| `reportBack` | No | Whether to relay results back to this session (default `true`); set to `false` for successors or detached sessions |
| `wake` | No | Whether dispatching wakes the target into a new turn (default `true`); set to `false` for silent reports |

```text
spin-session({
  "text": "Research the repository and prepare an implementation plan",
  "model": "github-copilot/gpt-5.4-mini",
  "title": "[WRK] Repository research"
})
```

The tool returns immediately with a child session ID. The result arrives later through a parent message.

### `spin-talk`

Sends a follow-up to an existing child. Use this for every subsequent step. Pass the actual session ID returned by Spin, beginning with `ses`; titles and semantic names are not valid IDs.

| Argument | Required | Description |
| --- | --- | --- |
| `sessionID` | Yes | Existing child ID beginning with `ses` |
| `text` | Yes | Follow-up prompt |
| `model` | Yes | Model in `provider/model` form; switch models between steps |
| `agent` | No | Optional agent override |
| `reportBack` | No | Whether to relay results back to this session (default `true`); set to `false` for detached dispatches |
| `wake` | No | Whether dispatching wakes the target into a new turn (default `true`); set to `false` for silent reports |
| `envelope` | No | Wrap the message as an inter-agent child report; set `true` when escalating to another session (default `false`) |

```text
spin-talk({
  "sessionID": "ses_abc123xyz",
  "text": "Now implement the approved plan",
  "model": "openrouter/z-ai/glm-5.2"
})
```

Only one active dispatch may control a child at a time, and a child cannot be controlled by two parent sessions simultaneously.

### `spin-interrupt`

Aborts an active child dispatch:

```text
spin-interrupt({ "sessionID": "ses_abc123xyz" })
```

### `spin-id`

Returns this session's own ID. Use it when a session must hand its ID to another session (for example, a parent giving children the address to report back to). Takes no arguments:

```text
spin-id({})
```

## A practical workflow

Use a cheap model for exploration, a stronger model for review, and switch back when implementation is routine:

```text
1. spin-session  → Scout: inspect the task and prepare evidence
2. spin-talk     → Judge: review the evidence and decide
3. spin-talk     → Implement: make the approved changes
4. spin-talk     → Review: inspect the resulting diff
```

Each child has its own context. Start separate `spin-session` calls for genuinely parallel work, then continue each with its own `sessionID`.

The bundled `spin-lead` skill defines these orchestration mechanics; `spin-worker` defines the Scout/Judge role discipline that each child session loads on the parent's request; `spin-rnd` provides the Scout-Judge development loop and `spin-ops` the direct operations workflow where Judge is dispatched only when the judge floor applies; `spin-head` sits above leads and runs a program of independent tracks, one lead each.

### Head hub mode

A Head session coordinates several leads. Leads spun with `reportBack: false` escalate to the Head session ID when they have a decision-worthy outcome or blocker. Escalations use `spin-talk` with `envelope: true`, `wake: false`: the plugin never wakes a Head on its own, so only user input starts a Head turn. The Head reads pending reports at the start of its next user turn.

### Async relays and turns

Dispatches are asynchronous by default. Spin listens for child `session.idle` and `session.error` events, reads the completed assistant message, and relays the result to the originating parent. A child can be controlled only after its previous result has been relayed.

### Context compaction recovery

If a child context is compacted during a dispatch, the relay marks that fact. Before continuing, ask the child to re-read the relevant files, realign with the original task, estimate progress, and create a new plan. Compaction may remove substantial working context.

Relays report child context size in 50k-token steps as `tokens(Nk)`. At >300k, relays append a soft notice to prefer fresh child sessions — split into parallel children only when a large amount of remaining work is expected — leaving the mechanics to the parent; at >500k, the notice becomes a hard warning that the child's output is no longer trustworthy and substantive work should move elsewhere. A retiring child may spawn its own successor children and report their sessionIds; those may still be busy at first contact, so `spin-talk` errors are expected until their current task settles.

Parent sessions receive matching notices about their own context — a soft notice at >300k to either steer the current work to completion without new work or new dispatches, or prepare a handover; and a hard warning at >500k to retire — injected silently into the session when the parent goes idle. Retirement writes a generous handover file and spins exactly one successor via `spin-session` with `reportBack: false` referencing that file. Handover happens only when every child is idle — or when the user asks for it — since active children relay results to the session that dispatched them, so handing over mid-dispatch would split control. Handovers are generous — open items, decisions, sessionIds, file paths, reasoning, and validation results — but never pasted file contents.

### Agent discovery

Spin discovers primary agents from `.md` files under `~/.config/opencode/agent/` and the project’s `.opencode/agent/`. It also supplies built-in `build` and `plan` agents unless overridden, and respects disabled agents in the corresponding OpenCode configuration files.

## Important limitations

- Active dispatches, ownership, and compaction markers are held in plugin memory. Restarting OpenCode loses that orchestration state; start or recover children again after a restart.
- Child session IDs are required for follow-ups and interrupts.
- A child result can be delayed while OpenCode finishes publishing its completed assistant message.
- Spin depends on OpenCode’s plugin and SDK APIs and declares compatibility with `@opencode-ai/plugin` `^0.15.18`.

## Updating

Pin a version in `opencode.json` when reproducibility matters. If OpenCode is holding a stale cached npm installation, restart it first; clearing `~/.cache/opencode` is a disruptive last-resort recovery step because it removes the complete OpenCode package cache.

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
