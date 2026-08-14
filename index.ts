/**
 * OpenCode Spin Plugin
 *
 * Worker session orchestration with agent switching and cross-session control.
 *
 * Features:
 * - Spawn worker sessions with initial prompts
 * - Send follow-up prompts to worker sessions
 * - Relay worker results back to orchestrator sessions
 * - Multiple worker sessions per orchestrator
 *
 * @version 1.0.0
 * @license MIT
 * @author M. Adel Alhashemi
 * @see https://github.com/malhashemi/opencode-sessions
 */

import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { join } from "path"
import { readdir } from "fs/promises"
import os from "os"
import matter from "gray-matter"

const ENABLE_ALL_COMM_MODES = false

interface AgentInfo {
  name: string
  description?: string
}

interface AssistantMessageInfo {
  id: string
  role: "assistant"
  providerID: string
  modelID: string
  error?: unknown
  time: {
    created: number
    completed?: number
  }
  tokens?: {
    input: number
    output: number
    reasoning: number
    cache: {
      read: number
      write: number
    }
  }
}

/**
 * Discover primary agents by scanning agent directories for markdown files
 * and checking opencode.json for disabled agents.
 *
 * Agent discovery process:
 * 1. Scans ~/.config/opencode/agent/ and .opencode/agent/ for .md files
 * 2. Parses YAML frontmatter to find agents with mode: "primary" or "all"
 * 3. Adds built-in agents (build, plan) if not overridden by .md files
 * 4. Checks opencode.json files for disabled agents
 * 5. Returns list of enabled primary agents
 *
 * Note: Built-in agents (build, plan) can be:
 * - Overridden by creating build.md or plan.md files
 * - Disabled via opencode.json with { agent: { build: { disable: true } } }
 */
async function discoverAgents(projectDir: string): Promise<AgentInfo[]> {
  const agents: AgentInfo[] = []
  const disabledAgents = new Set<string>()

  // Determine XDG config paths
  const xdgConfigHome = process.env.XDG_CONFIG_HOME
  const xdgBase = xdgConfigHome
    ? join(xdgConfigHome, "opencode")
    : join(os.homedir(), ".config/opencode")

  const agentDirs = [
    join(xdgBase, "agent"), // XDG config agents
    join(projectDir, ".opencode/agent"), // Project-local agents
  ]

  const configPaths = [
    join(xdgBase, "opencode.json"), // XDG config
    join(projectDir, ".opencode/opencode.json"), // Project-local config
  ]

  // First, discover all primary agents from markdown files
  for (const agentDir of agentDirs) {
    try {
      const files = await readdir(agentDir)

      for (const file of files) {
        // Only process markdown files
        if (!file.endsWith(".md")) continue

        try {
          // Read file content
          const filePath = join(agentDir, file)
          const content = await Bun.file(filePath).text()

          // Parse YAML frontmatter
          const { data } = matter(content)

          // Check if this is a primary agent
          const mode = data.mode
          if (mode === "primary" || mode === "all") {
            // Extract agent name from filename (remove .md extension)
            const agentName = file.replace(/\.md$/, "")
            const agentDescription = data.description

            // Add to list if not already present
            if (!agents.some((a) => a.name === agentName)) {
              agents.push({
                name: agentName,
                description: agentDescription,
              })
            }
          }
        } catch (error) {
          // Skip files that can't be parsed
          continue
        }
      }
    } catch (error) {
      // Silently skip directories that don't exist
      // This is expected - not all paths will have agent directories
    }
  }

  // Add built-in agents if they weren't overridden by .md files
  for (const builtIn of ["build", "plan"]) {
    if (!agents.some((a) => a.name === builtIn)) {
      agents.unshift({
        name: builtIn,
        description:
          builtIn === "build"
            ? "General-purpose implementation agent for building features and fixing bugs"
            : "Strategic planning agent for architecture and design decisions",
      })
    }
  }

  // Second, check opencode.json files for disabled agents
  for (const configPath of configPaths) {
    try {
      const file = Bun.file(configPath)
      if (await file.exists()) {
        const config = await file.json()

        // Check for disabled agents
        if (config.agent && typeof config.agent === "object") {
          for (const [name, agentConfig] of Object.entries(config.agent)) {
            if (typeof agentConfig === "object" && agentConfig !== null) {
              const disabled = (agentConfig as any).disable
              if (disabled) {
                disabledAgents.add(name)
              }
            }
          }
        }
      }
    } catch (error) {
      // Silently skip files that don't exist or can't be parsed
    }
  }

  // Filter out disabled agents
  return agents.filter((agent) => !disabledAgents.has(agent.name))
}

export const SpinPlugin: Plugin = async (ctx) => {
  // Discover agents from filesystem (no blocking API calls!)
  const agents = await discoverAgents(ctx.directory)
  await ctx.client.app.log({
    body: {
      service: "opencode-spin",
      level: "info",
      message: "SpinPlugin initialized",
      extra: {
        directory: ctx.directory,
        agents: agents.map((agent) => agent.name),
      },
    },
  })
  const agentList = agents
    .map((agent) => {
      const desc = agent.description || "No description available"
      return `  • ${agent.name} - ${desc}`
    })
    .join("\n")

  // Type definitions for state management
  type ModelOverride = {
    providerID: string
    modelID: string
  }

  type CommMode = "sync" | "async" | "off"

  type PendingDispatch = {
    orchestratorSessionID: string
    workerSessionID: string
    text: string
    agent?: string
    model?: ModelOverride
    comm: CommMode
    maxTurns: number
  }

  type ActiveDispatch = PendingDispatch & {
    dispatchedAt: number
    deadlineAt: number
    turn: number
    lastWorkerMessageID?: string
    inspecting?: boolean
  }

  // Store active worker dispatches waiting for worker result
  const activeDispatches = new Map<string, ActiveDispatch>()

  // Store sync callers waiting for worker completion
  const syncWaiters = new Map<
    string,
    {
      resolve: (value: string) => void
      reject: (reason: unknown) => void
    }
  >()

  // Worker sessions that were interrupted; upcoming idle events are swallowed
  const abortedWorkers = new Map<string, number>()
  // Sessions that compacted since their current dispatch started.
  const compactedWorkers = new Set<string>()

  // CEO mode: sessions opted in, busy state, and queued relays
  const ceoSessions = new Set<string>()
  const ceoBusy = new Set<string>()
  const ceoQueue = new Map<string, Array<{ text: string; noReply: boolean }>>()

  // Event types this plugin handles - early filter to skip noise
  const handledEventTypes = new Set(["session.idle", "session.error"])

  const workerResultRetryTimeoutMs = 36000000

  // Number of session.idle events to swallow after an interrupt/abort.
  // OpenCode emits a pair (idle from abort + idle from session teardown) before the worker truly settles.
  const abortedWorkersIdleSwallowCount = 2

  function validateSessionID(sessionID: string): string | null {
    if (!sessionID.startsWith("ses")) {
      return `Invalid session ID format. Session IDs must start with "ses" (e.g. "ses_abc123xyz"). Got: "${sessionID}". Use spin-talk to send a follow-up to an existing worker (pass the sessionID returned from a previous spin-session/spin-talk call). Semantic names like "spin-plane-redux" are not valid session IDs.`
    }
    return null
  }

  function parseModelOverride(model?: string): ModelOverride | undefined {
    if (!model) return undefined

    const slash = model.indexOf("/")
    if (slash <= 0 || slash === model.length - 1) {
      throw new Error(
        'Invalid model. Use "provider/model" format, e.g. "github-copilot/gpt-5.4-mini".',
      )
    }

    return {
      providerID: model.slice(0, slash),
      modelID: model.slice(slash + 1),
    }
  }

  async function sendPrompt(
    sessionID: string,
    options: {
      text: string
      agent?: string
      model?: ModelOverride
      noReply?: boolean
    },
  ) {
    const body: {
      agent?: string
      model?: ModelOverride
      noReply?: boolean
      parts: Array<{ type: "text"; text: string }>
    } = {
      parts: [{ type: "text", text: options.text }],
    }

    if (options.agent) body.agent = options.agent
    if (options.model) body.model = options.model
    if (options.noReply) body.noReply = true

    return ctx.client.session.prompt({
      path: { id: sessionID },
      body,
    })
  }

  async function relayToOrchestrator(
    orchestratorSessionID: string,
    options: { text: string; noReply: boolean },
  ) {
    if (ceoSessions.has(orchestratorSessionID)) {
      if (ceoBusy.has(orchestratorSessionID)) {
        const queue = ceoQueue.get(orchestratorSessionID)
        if (queue) {
          queue.push(options)
        } else {
          ceoQueue.set(orchestratorSessionID, [options])
        }
        return
      }
      ceoBusy.add(orchestratorSessionID)
    }
    await sendPrompt(orchestratorSessionID, options)
  }

  function extractTextParts(parts: Array<{ type: string; text?: string }>) {
    return parts
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text?.trim())
      .filter(Boolean)
      .join("\n\n")
  }

  function summarizeSessionContent(messages: Array<{
    info: { role: string; time: { created: number } }
    parts: Array<{ type: string; text?: string }>
  }>) {
    return `msgs(${messages.length})`
  }

  function isCompletedAssistantMessage(message: {
    info: {
      id: string
      role: string
      time: {
        created: number
        completed?: number
      }
    }
    parts: Array<{ type: string; text?: string }>
  }): message is {
    info: AssistantMessageInfo
    parts: Array<{ type: string; text?: string }>
  } {
    return (
      message.info.role === "assistant" &&
      message.info.time.created > 0 &&
      Boolean(message.info.time.completed)
    )
  }

  function formatWorkerResult(
    dispatch: ActiveDispatch,
    text: string,
    usage?: { tokens?: AssistantMessageInfo["tokens"] },
    sessionSummary?: string,
    compacted = false,
    title = "Worker step complete.",
  ) {
    const details = [
      `sessionId=${dispatch.workerSessionID}`,
      dispatch.agent ? `agent=${dispatch.agent}` : undefined,
      dispatch.model
        ? `model=${dispatch.model.providerID}/${dispatch.model.modelID}`
        : undefined,
    ]
      .filter(Boolean)
      .join(" ")

    const tokens = usage?.tokens
    const usageLine = tokens
      ? `tokens(${(tokens.input ?? 0) + (tokens.output ?? 0) + (tokens.cache?.read ?? 0) + (tokens.cache?.write ?? 0)})`
      : undefined

    return [
      `${title} This message is Not visible for the user. ${details}${usageLine ? ` ${usageLine}` : ""}${sessionSummary ? ` ${sessionSummary}` : ""}${compacted ? "\nWorker context was compacted during this step." : ""}`,
      text || "[Worker produced no text output]",
      ...(compacted
        ? [
            "Worker context was compacted and may have lost substantial context. Before continuing, use spin-talk to ask the worker to re-read the relevant files, realign with the original task, estimate current progress, and create a new plan.",
          ]
        : []),
    ].join("\n\n")
  }

  function formatWorkerTarget(dispatch: {
    workerSessionID: string
    agent?: string
    model?: ModelOverride
  }) {
    const details = [
      `worker=${dispatch.workerSessionID}`,
      dispatch.agent ? `agent=${dispatch.agent}` : undefined,
      dispatch.model
        ? `model=${dispatch.model.providerID}/${dispatch.model.modelID}`
        : undefined,
    ]
      .filter(Boolean)
      .join(" ")

    return details
  }

  function removeActiveDispatch(
    sessionID: string,
    dispatch?: ActiveDispatch,
  ): ActiveDispatch | undefined {
    const current = activeDispatches.get(sessionID)
    if (!current) return undefined
    if (dispatch && current !== dispatch) return undefined
    activeDispatches.delete(sessionID)
    return current
  }

  async function failActiveDispatch(
    sessionID: string,
    dispatch: ActiveDispatch,
    message: string,
  ) {
    const settledDispatch = removeActiveDispatch(sessionID, dispatch)
    if (!settledDispatch) return

    // Clean compaction flag before the sync short-circuit, so a retry on this
    // session isn't falsely notified and the error relay can report it too.
    const wasCompacted = compactedWorkers.delete(sessionID)

    const waiter = syncWaiters.get(sessionID)
    if (waiter) {
      syncWaiters.delete(sessionID)
      waiter.reject(new Error(message))
      return
    }

    const errorBody = `Error: ${message}\n\nThe worker result could not be recovered. Send your next instruction when ready.`

    try {
      await relayToOrchestrator(settledDispatch.orchestratorSessionID, {
        noReply: true,
        text: formatWorkerResult(
          settledDispatch,
          errorBody,
          undefined,
          undefined,
          wasCompacted,
          "Worker step failed.",
        ),
      })
    } catch {
      // Silently fail - plugin should not loop on notification errors
    }
  }

  async function inspectWorkerResult(sessionID: string) {
    const activeDispatch = activeDispatches.get(sessionID)
    if (!activeDispatch || activeDispatch.inspecting) {
      return
    }

    activeDispatch.inspecting = true

    if (Date.now() >= activeDispatch.deadlineAt) {
      await failActiveDispatch(
        sessionID,
        activeDispatch,
        "Worker result did not become available within the retry deadline.",
      )
      return
    }

    try {
      const messages = await ctx.client.session.messages({
        path: { id: sessionID },
      })

      const assistantMessages = messages.data
        .filter(isCompletedAssistantMessage)
        .filter((message) => message.info.id !== activeDispatch.lastWorkerMessageID)

      const latest = assistantMessages[assistantMessages.length - 1]
      if (!latest) {
        void failActiveDispatch(
          sessionID,
          activeDispatch,
          "Worker completed but no assistant message became available.",
        )
        return
      }

      const settledDispatch = removeActiveDispatch(sessionID, activeDispatch)
      if (!settledDispatch) return

      const nextTurn = settledDispatch.turn + 1
      const text = extractTextParts(latest.parts)
      const latestInfo = latest.info as AssistantMessageInfo
      const sessionSummary = summarizeSessionContent(messages.data)

      const payload = formatWorkerResult(
        {
          ...settledDispatch,
          turn: nextTurn,
          lastWorkerMessageID: latestInfo.id,
        },
        latestInfo.error
          ? `${text}\n\nWorker error: ${JSON.stringify(latestInfo.error)}`
          : text,
        { tokens: latestInfo.tokens },
        sessionSummary,
        compactedWorkers.delete(sessionID),
      )

      if (settledDispatch.comm === "sync") {
        const waiter = syncWaiters.get(sessionID)
        if (waiter) {
          syncWaiters.delete(sessionID)
          waiter.resolve(payload)
        }

        return
      }

      const shouldContinue =
        settledDispatch.comm === "async" &&
        nextTurn <= settledDispatch.maxTurns

      await relayToOrchestrator(settledDispatch.orchestratorSessionID, {
        noReply: !shouldContinue,
        text: shouldContinue
          ? `${payload}\n\nUser is unaware of this message. Follow Spin Orchestrator workflow and rules. Decide next step as Spin orchestrator: Dispatch again, ask user, or stop.`
          : `${payload}\n\nUser is unaware of this message. Stopping here.${settledDispatch.comm === "async" ? ` Reached maxTurns=${settledDispatch.maxTurns}.` : ""}`,
      })
    } catch (error) {
      void failActiveDispatch(
        sessionID,
        activeDispatch,
        error instanceof Error
          ? error.message
          : "Failed to read worker session messages.",
      )
    }
  }

  // Shared dispatch: validates the worker sessionID isn't the orchestrator's
  // own, registers the dispatch, runs sync/async path, and returns the
  // standard "Prompt dispatched" message. Used by both spin-session (after it
  // creates a session) and spin-talk.
  const dispatchToWorker = async (
    workerSessionID: string,
    args: {
      text: string
      agent?: string
      model: string
      comm?: "sync" | "async" | "off"
      maxTurns?: number
    },
    toolCtx: { sessionID: string },
  ): Promise<string> => {
    if (workerSessionID === toolCtx.sessionID) {
      throw new Error("worker sessionID must be different from current session.")
    }

    const existingDispatch = activeDispatches.get(workerSessionID)
    if (
      existingDispatch &&
      existingDispatch.orchestratorSessionID !== toolCtx.sessionID
    ) {
      throw new Error(
        `Worker session ${workerSessionID} is already controlled by another orchestrator session.`,
      )
    }

    if (existingDispatch) {
      throw new Error(
        `Worker session ${workerSessionID} is still busy. Wait for its next relayed result before sending another prompt.`,
      )
    }

    if (!args.text) {
      throw new Error("text is required.")
    }

    abortedWorkers.delete(workerSessionID)

    const model = parseModelOverride(args.model)
    const comm = args.comm ?? "async"
    const maxTurns = Math.max(0, Math.floor(args.maxTurns ?? 10))

    const pendingDispatch: PendingDispatch = {
      orchestratorSessionID: toolCtx.sessionID,
      workerSessionID,
      text: args.text,
      agent: args.agent,
      model,
      comm,
      maxTurns,
    }

    if (comm === "sync") {
      const result = new Promise<string>((resolve, reject) => {
        syncWaiters.set(workerSessionID, { resolve, reject })
      })

      const activeDispatch: ActiveDispatch = {
        ...pendingDispatch,
        turn: 0,
        dispatchedAt: Date.now(),
        deadlineAt: Date.now() + workerResultRetryTimeoutMs,
      }

      activeDispatches.set(workerSessionID, activeDispatch)

      try {
        await sendPrompt(workerSessionID, {
          agent: pendingDispatch.agent,
          model: pendingDispatch.model,
          text: pendingDispatch.text,
        })
      } catch (error) {
        activeDispatches.delete(workerSessionID)
        syncWaiters.delete(workerSessionID)

        const message = error instanceof Error ? error.message : String(error)
        throw new Error(message)
      }

      return await result
    }

    const activeDispatch: ActiveDispatch = {
      ...pendingDispatch,
      turn: 0,
      dispatchedAt: Date.now(),
      deadlineAt: Date.now() + workerResultRetryTimeoutMs,
    }

    activeDispatches.set(workerSessionID, activeDispatch)

    sendPrompt(workerSessionID, {
      agent: pendingDispatch.agent,
      model: pendingDispatch.model,
      text: pendingDispatch.text,
    }).catch(async (error) => {
      activeDispatches.delete(workerSessionID)

      const message = error instanceof Error ? error.message : String(error)

      try {
        await relayToOrchestrator(pendingDispatch.orchestratorSessionID, {
          noReply: true,
          text: `Worker dispatch failed. ${formatWorkerTarget(pendingDispatch)}\n\n${message}`,
        })
      } catch {
        // Silently fail - plugin should not loop on notification errors
      }
    })

    return `Prompt dispatched to worker. ${formatWorkerTarget(pendingDispatch)}. You will be notified when worker step is complete. You can stop now.`
  }

  // Standard error handling for the spin-* tools: surface failure as a toast
  // and re-throw so the OpenCode UI shows it in red. spin-interrupt has its
  // own slightly different toast label and stays unwrapped.
  const withErrorToast = async (action: string, fn: () => Promise<string>) => {
    try {
      return await fn()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await ctx.client.tui.showToast({
        body: { message: `${action}: ${message}`, variant: "error" },
      })
      throw error
    }
  }

  const hooks = {
    // Hook: Listen for session and worker events
    event: async ({ event }) => {
      // Early filter: skip events we don't handle
      if (!handledEventTypes.has(event.type)) return

      // ===== Handle session.idle =====
      if (event.type === "session.idle") {
        // Type guard for events with sessionID
        if (!("properties" in event) || !("sessionID" in event.properties)) {
          return
        }

        const sessionID = event.properties.sessionID as string

        // Swallow idle events for an interrupted worker
        const swallowCount = abortedWorkers.get(sessionID)
        if (swallowCount !== undefined) {
          if (swallowCount <= 1) {
            abortedWorkers.delete(sessionID)
          } else {
            abortedWorkers.set(sessionID, swallowCount - 1)
          }
          return
        }

        // CEO drain: when a CEO session finishes processing a relay, dequeue next
        if (ceoBusy.has(sessionID)) {
          ceoBusy.delete(sessionID)
          const queue = ceoQueue.get(sessionID)
          if (queue && queue.length > 0) {
            const next = queue.shift()!
            if (queue.length === 0) ceoQueue.delete(sessionID)
            try {
              await relayToOrchestrator(sessionID, next)
            } catch {
              // Silently fail - plugin should not loop on notification errors
            }
          }
        }

        if (!activeDispatches.has(sessionID)) {
          return
        }

        // Worker finished a dispatched turn, relay result back
        await inspectWorkerResult(sessionID)
      }

      // ===== Handle session.error =====
      if (event.type === "session.error") {
        const properties = event.properties as {
          sessionID?: string
          error?: {
            name?: string
            data?: {
              message?: string
            }
          }
        }

        const sessionID = properties.sessionID
        if (!sessionID || !activeDispatches.has(sessionID)) return

        const activeDispatch = activeDispatches.get(sessionID)!

        // Mark the worker as aborted so the following idle events are ignored
        abortedWorkers.set(sessionID, abortedWorkersIdleSwallowCount)
        removeActiveDispatch(sessionID, activeDispatch)

        // Clean compaction flag before the sync short-circuit.
        const wasCompacted = compactedWorkers.delete(sessionID)

        const errorLabel = properties.error?.name
          ? `${properties.error.name}${properties.error.data?.message ? `: ${properties.error.data.message}` : ""}`
          : "Unknown worker error"

        const waiter = syncWaiters.get(sessionID)
        if (waiter) {
          syncWaiters.delete(sessionID)
          waiter.reject(new Error(errorLabel))
          return
        }

        const errorBody = `Error: ${errorLabel}\n\nThe worker has been aborted. Send your next instruction when ready.`

        try {
          await relayToOrchestrator(activeDispatch.orchestratorSessionID, {
            noReply: true,
            text: formatWorkerResult(
              activeDispatch,
              errorBody,
              undefined,
              undefined,
              wasCompacted,
              "Worker step failed.",
            ),
          })
        } catch {
          // Silently fail - plugin should not loop on notification errors
        }
      }
    },

    tool: {
      "spin-session": tool({
        description: `Create a new worker session and dispatch the first prompt.

Use this to start a new worker. To send a follow-up to an existing worker, use spin-talk with that worker's sessionID.

Returns the standard "Prompt dispatched" status. The worker result is relayed back to the orchestrator when the worker goes idle.
`,

        args: {
          text: tool.schema.string().describe("The prompt to send"),
          model: tool.schema
            .string()
            .describe('Model "provider/model" form, e.g. "github-copilot/gpt-5.4-mini"'),
          agent: tool.schema
            .string()
            .optional()
            .describe(
              "Optional AGENT SELECTION: only set agent if user asks for it. Available agents: ${agentList}",
            ),
          title: tool.schema
            .string()
            .optional()
            .describe("Human-readable label for the new worker session. Prefix with [WRK]."),
          ...(ENABLE_ALL_COMM_MODES
            ? {
                comm: tool.schema
                  .enum(["sync", "async", "off"])
                  .optional()
                  .describe(
                    'Communication mode: "sync" blocks until worker goes idle, "async" relays result later, "off" relays result, but you will see it when user allows it. Default: "async"',
                  ),
              }
            : {}),
          maxTurns: tool.schema
            .number()
            .optional()
            .describe("Safety cap for number of interractions to the session. Default: 10. Don't set unless user asks for it."),
          ceo: tool.schema
            .boolean()
            .optional()
            .describe("Enable CEO mode for this session. Worker relays are queued while CEO is busy processing a previous relay."),
        },

        async execute(args, toolCtx) {
          return withErrorToast("Session operation failed", async () => {
            if (args.ceo) ceoSessions.add(toolCtx.sessionID)
            const newSession = await ctx.client.session.create({
              body: args.title ? { title: args.title } : {},
            })
            return await dispatchToWorker(newSession.data.id, args, toolCtx)
          })
        },
      }),

      "spin-talk": tool({
        description: `Send a follow-up prompt to an existing worker session.

Use this for every step after the first. To create a new worker, use spin-session instead.

Returns the standard "Prompt dispatched" status. The worker result is relayed back to the orchestrator when the worker goes idle.
`,

        args: {
          sessionID: tool.schema
            .string()
            .describe(
              "Existing worker session ID (must start with 'ses'). Use the ID returned from a previous spin-session or spin-talk call. Not a semantic name or title.",
            ),
          text: tool.schema.string().describe("The prompt to send"),
          model: tool.schema
            .string()
            .describe('Model "provider/model" form, e.g. "github-copilot/gpt-5.4-mini"'),
          agent: tool.schema
            .string()
            .optional()
            .describe(
              "Optional AGENT SELECTION: only set agent if user asks for it. Available agents: ${agentList}",
            ),
          ...(ENABLE_ALL_COMM_MODES
            ? {
                comm: tool.schema
                  .enum(["sync", "async", "off"])
                  .optional()
                  .describe(
                    'Communication mode: "sync" blocks until worker goes idle, "async" relays result later, "off" relays result, but you will see it when user allows it. Default: "async"',
                  ),
              }
            : {}),
          maxTurns: tool.schema
            .number()
            .optional()
            .describe("Safety cap for number of interractions to the session. Default: 10. Don't set unless user asks for it."),
          ceo: tool.schema
            .boolean()
            .optional()
            .describe("Enable CEO mode for this session. Worker relays are queued while CEO is busy processing a previous relay."),
        },

        async execute(args, toolCtx) {
          return withErrorToast("Session operation failed", async () => {
            if (args.ceo) ceoSessions.add(toolCtx.sessionID)
            const validationError = validateSessionID(args.sessionID)
            if (validationError) throw new Error(validationError)
            return await dispatchToWorker(args.sessionID, args, toolCtx)
          })
        },
      }),

      "spin-interrupt": tool({
        description: `Abort an active worker session.

Stops dispatches in progress and removes queued prompts for the worker. Requires the actual session ID returned from a previous spin-session or spin-talk call.

- sessionID: worker session ID (starts with "ses")
- Aborts in-progress dispatch (if controlled by this orchestrator) and rejects any sync waiter
- Removes queued prompts for the worker across all orchestrators
- Marks the worker so upcoming idle events are swallowed

EXAMPLE:

   # ABORT A WORKER
   spin-interrupt({
     sessionID: "ses_abc123xyz"
   })
`,

        args: {
          sessionID: tool.schema
            .string()
            .describe(
              "Existing worker session ID (must start with 'ses'). Use the ID returned from a previous spin-session or spin-talk call.",
            ),
        },

        async execute(args, toolCtx) {
          try {
            const workerSessionID = args.sessionID

            const validationError = validateSessionID(workerSessionID)
            if (validationError) {
              throw new Error(validationError)
            }

            const activeDispatch = activeDispatches.get(workerSessionID)
            if (
              activeDispatch &&
              activeDispatch.orchestratorSessionID !== toolCtx.sessionID
            ) {
              throw new Error(`Worker session ${workerSessionID} is controlled by another orchestrator session.`)
            }

            if (!activeDispatch) {
              return `Worker ${workerSessionID} has no active dispatch; nothing to interrupt.`
            }

            removeActiveDispatch(workerSessionID, activeDispatch)
            abortedWorkers.set(workerSessionID, abortedWorkersIdleSwallowCount)
            // Consume compaction flag before the sync short-circuit, so a retry on
            // this session isn't falsely notified and the relay can report it.
            const wasCompacted = compactedWorkers.delete(workerSessionID)
            await ctx.client.session.abort({ path: { id: workerSessionID } })

            const waiter = syncWaiters.get(workerSessionID)
            if (waiter) {
              syncWaiters.delete(workerSessionID)
              waiter.reject(new Error("Worker interrupted by orchestrator"))
            } else {
              const interruptBody = `Worker was interrupted by the orchestrator.\n\nThe worker has been aborted. Send your next instruction when ready.`
              try {
                await relayToOrchestrator(activeDispatch.orchestratorSessionID, {
                  noReply: true,
                  text: formatWorkerResult(
                    activeDispatch,
                    interruptBody,
                    undefined,
                    undefined,
                    wasCompacted,
                    "Worker step interrupted.",
                  ),
                })
              } catch {
                // Silently fail - plugin should not loop on notification errors
              }
            }

            return `Worker ${workerSessionID} interrupted.`
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error)

            await ctx.client.tui.showToast({
              body: {
                message: `Interrupt failed: ${message}`,
                variant: "error",
              },
            })

            throw error
          }
        },
      }),
    },
  }

  // This hook is available in current OpenCode versions but not in the older
  // plugin typings supported by this package. Keep the compatibility cast local.
  return {
    ...hooks,
    "experimental.session.compacting": async (input: { sessionID: string }) => {
      if (activeDispatches.has(input.sessionID)) {
        compactedWorkers.add(input.sessionID)
      }
    },
  } as any
}
