# OpenCode Spin

[![npm version](https://img.shields.io/npm/v/opencode-spin.svg)](https://www.npmjs.com/package/opencode-spin)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> Orchestrate OpenCode worker sessions across models, agents, and parallel tasks.

Spin gives an OpenCode orchestrator three focused tools for creating workers, continuing them, and stopping them. Worker results are relayed back to the orchestrator, so a workflow can move from research to review to implementation without losing the worker session.

## Why Spin

- Delegate a task to an isolated worker session.
- Switch models or agents between workflow steps.
- Run independent workers in parallel.
- Receive completed results asynchronously instead of blocking the orchestrator.
- Interrupt a worker that is stuck or no longer useful.
- Recover deliberately when a worker's context is compacted.

## Install

**Compatibility:** the package declares `@opencode-ai/plugin` `^0.15.18`. Node.js `>= 20` is required for the development/advanced installer path.

The primary installation path is OpenCode's npm plugin configuration:

```json
{
  "plugin": ["opencode-spin"]
}
```

Add this to `opencode.json` in a project or to `~/.config/opencode/opencode.json`, then restart OpenCode. OpenCode installs npm plugins at startup. Spin automatically exposes its bundled `Spin`, `spin-rnd`, `spin-ops`, and `Pall` skills through the plugin; no separate skill installation is required.

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
- copies `skills/{spin,spin-rnd,spin-ops,pall}/SKILL.md` to global OpenCode skill directories;
- adds runtime dependencies to `~/.config/opencode/package.json` when absent;
- removes matching legacy `kanrisha`/`knr` plugin entries and files to prevent duplicate instances;
- removes the legacy `~/.config/opencode/skills/knr` directory.

These are global configuration and filesystem changes. Review them before running the command, and restart OpenCode afterward. Do not combine this local plugin copy with an npm plugin entry for Spin: duplicate instances split in-memory dispatch state.

## The tools

### `spin-session`

Creates a new worker session and dispatches its first prompt.

| Argument | Required | Description |
| --- | --- | --- |
| `text` | Yes | Prompt for the worker |
| `model` | Yes | Model in `provider/model` form, such as `github-copilot/gpt-5.4-mini` |
| `agent` | No | Agent name; set only when a specific agent is requested |
| `title` | No | Worker title; `[WRK]` is recommended |
| `maxTurns` | No | Optional dispatch setting; defaults to `10` |

```text
spin-session({
  "text": "Research the repository and prepare an implementation plan",
  "model": "github-copilot/gpt-5.4-mini",
  "title": "[WRK] Repository research"
})
```

The tool returns immediately with a worker session ID. The result arrives later through an orchestrator message.

### `spin-talk`

Sends a follow-up to an existing worker. Use this for every subsequent step. Pass the actual session ID returned by Spin, beginning with `ses`; titles and semantic names are not valid IDs.

| Argument | Required | Description |
| --- | --- | --- |
| `sessionID` | Yes | Existing worker ID beginning with `ses` |
| `text` | Yes | Follow-up prompt |
| `model` | Yes | Model in `provider/model` form; switch models between steps |
| `agent` | No | Optional agent override |
| `maxTurns` | No | Optional dispatch setting; defaults to `10` |

```text
spin-talk({
  "sessionID": "ses_abc123xyz",
  "text": "Now implement the approved plan",
  "model": "openrouter/z-ai/glm-5.2"
})
```

Only one active dispatch may control a worker at a time, and a worker cannot be controlled by two orchestrator sessions simultaneously.

### `spin-interrupt`

Aborts an active worker dispatch:

```text
spin-interrupt({ "sessionID": "ses_abc123xyz" })
```

## A practical workflow

Use a cheap model for exploration, a stronger model for review, and switch back when implementation is routine:

```text
1. spin-session  → Scout: inspect the task and prepare evidence
2. spin-talk     → Judge: review the evidence and decide
3. spin-talk     → Implement: make the approved changes
4. spin-talk     → Review: inspect the resulting diff
```

Each worker has its own context. Start separate `spin-session` calls for genuinely parallel work, then continue each with its own `sessionID`.

The bundled `spin` skill defines these orchestration mechanics; `spin-rnd` provides the Scout-Judge development loop and `spin-ops` the direct operations workflow where Judge is dispatched only when the judge floor applies.

### Async relays and turns

Dispatches are asynchronous by default. Spin listens for worker `session.idle` and `session.error` events, reads the completed assistant message, and relays the result to the originating orchestrator. A worker can be controlled only after its previous result has been relayed. `maxTurns` is accepted as an optional dispatch setting; its enforcement is not presented as a guaranteed session-turn limit.

### Context compaction recovery

If a worker context is compacted during a dispatch, the relay marks that fact. Before continuing, ask the worker to re-read the relevant files, realign with the original task, estimate progress, and create a new plan. Compaction may remove substantial working context.

Relays report worker context size in 50k-token steps as `tokens(Nk)`. Notices fire when a threshold is crossed, not on exact equality, so a sudden jump (e.g. 250k to 350k) still triggers the 300k notice. At 300k the relay appends a soft notice to prefer fresh worker sessions — split into parallel workers only when a large amount of remaining work is expected — leaving the mechanics to the orchestrator; at 500k and every 100k beyond, the notice is a hard warning that the worker's output is no longer trustworthy and substantive work should move elsewhere. A retiring worker may spawn its own successor workers and report their sessionIds; those may still be busy at first contact, so `spin-talk` errors are expected until their current task settles.

Orchestrator sessions receive matching notices about their own context — a soft notice at 300k to either steer the current work to completion without new work or new dispatches, or prepare a handover; and a hard warning at 500k and every 100k beyond to retire — injected silently into the session when the orchestrator goes idle. Retirement spins exactly one successor orchestrator with the entire handover in that single prompt. Handover happens only when every worker is idle — or when the user asks for it — since active workers relay results to the session that dispatched them, so handing over mid-dispatch would split control. Handovers are pointer-based everywhere — open items, decisions, sessionIds, and file paths to look at — never pasted file contents.

### Agent discovery

Spin discovers primary agents from `.md` files under `~/.config/opencode/agent/` and the project’s `.opencode/agent/`. It also supplies built-in `build` and `plan` agents unless overridden, and respects disabled agents in the corresponding OpenCode configuration files.

## Important limitations

- Active dispatches, ownership, and compaction markers are held in plugin memory. Restarting OpenCode loses that orchestration state; start or recover workers again after a restart.
- Worker session IDs are required for follow-ups and interrupts.
- A worker result can be delayed while OpenCode finishes publishing its completed assistant message.
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
