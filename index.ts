/**
 * OpenCode Spin Plugin
 *
 * Worker session orchestration with agent switching and cross-session control.
 *
 * Features:
 * - Spawn worker sessions with initial prompts
 * - Send follow-up prompts to worker sessions
 * - Run one-shot boxed child sessions with model override (spin-box)
 * - Relay worker results back to lead sessions
 * - Multiple worker sessions per lead
 *
 * @version 1.1.0
 * @license MIT
 * @author M. Adel Alhashemi
 * @see https://github.com/malhashemi/opencode-sessions
 */

import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { dirname, join } from "path"
import { fileURLToPath } from "url"
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
    leadSessionID: string
    workerSessionID: string
    workerSlug?: string
    text: string
    agent?: string
    model?: ModelOverride
    comm: CommMode
    maxTurns: number
    relay: boolean
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

  // CEO mode: sessions opted in, plus silent reports waiting for a busy CEO.
  // CEO sessions are user-driven: the plugin never wakes them. Every report
  // to a CEO is delivered with noReply: true; only user input starts a turn.
  const ceoSessions = new Set<string>()
  const ceoQueue = new Map<
    string,
    Array<{ text: string; agent?: string; model?: ModelOverride }>
  >()

  function queueCeoReport(
    sessionID: string,
    item: { text: string; agent?: string; model?: ModelOverride },
  ) {
    const queued = ceoQueue.get(sessionID)
    if (queued) queued.push(item)
    else ceoQueue.set(sessionID, [item])
  }

  async function deliverToCeo(
    sessionID: string,
    item: { text: string; agent?: string; model?: ModelOverride },
  ) {
    try {
      await sendPrompt(sessionID, { ...item, noReply: true })
    } catch {
      // Session busy; keep the report for the next idle drain.
      queueCeoReport(sessionID, item)
    }
  }

  // Sessions that dispatched at least once (leads). Their own context
  // size is checked on idle.
  const leadSessions = new Set<string>()

  // Event types this plugin handles - early filter to skip noise
  const handledEventTypes = new Set(["session.idle", "session.error"])

  const workerResultRetryTimeoutMs = 36000000

  // Number of session.idle events to swallow after an interrupt/abort.
  // OpenCode emits a pair (idle from abort + idle from session teardown) before the worker truly settles.
  const abortedWorkersIdleSwallowCount = 2

  // Window for a late session.error to preempt a premature session.idle.
  // UI Stop can emit idle before error; the deferred idle check drops if
  // the error path removed the dispatch or armed the swallow in between.
  const workerIdleSettleMs = 600

  function validateSessionID(sessionID: string): string | null {
    if (!sessionID.startsWith("ses")) {
      return `Invalid session ID format. Session IDs must start with "ses" (e.g. "ses_abc123xyz"). Got: "${sessionID}". Use spin-talk to send a follow-up to an existing session (pass the sessionID returned from a previous spin-session/spin-talk call). Semantic names like "spin-plane-redux" are not valid session IDs.`
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

  async function relayToLead(
    leadSessionID: string,
    options: { text: string; noReply: boolean },
  ) {
    if (ceoSessions.has(leadSessionID)) {
      // CEO sessions are user-driven: deliver silently, never wake them.
      await deliverToCeo(leadSessionID, { text: options.text })
      return
    }
    await sendPrompt(leadSessionID, options)
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
    title = "Step complete.",
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
    const totalTokens = tokens
      ? (tokens.input ?? 0) +
        (tokens.output ?? 0) +
        (tokens.cache?.read ?? 0) +
        (tokens.cache?.write ?? 0)
      : 0
    const stepped = Math.floor(totalTokens / 50000) * 50000
    const usageLine = tokens
      ? `tokens(${stepped === 0 ? "<50k" : `${stepped / 1000}k`})`
      : undefined

    let contextWarning: string | undefined
    if (tokens) {
      if (stepped >= 500000) {
        contextWarning = `Context limit (user guidance): session context reached tokens(${stepped / 1000}k) — past the trust boundary. Output may still seem usable but is too polluted to rely on. Do not continue substantive work in this session; move anything important to a fresh session. Retired session remains queryable via spin-talk for reference only.`
      } else if (stepped >= 300000) {
        contextWarning = `Context notice (user guidance): session context reached tokens(${stepped / 1000}k); output quality degrades at this size. Every follow-up also pays for retained context, so prefer a fresh session for a new substantive direction. If rotating, ask the retiring session for a generous handover file now. It should contain at least: reasoning, evidence, decisions, rejected alternatives, state, open questions, file paths, and validation results—not merely pointers or a compact brief. Retired session stays available via spin-talk for quick clarifications.`
      }
    }

    return [
      `${dispatch.workerSlug ? `${dispatch.workerSlug} ` : ""}${title} This message is Not visible for the user. ${details}${usageLine ? ` ${usageLine}` : ""}${sessionSummary ? ` ${sessionSummary}` : ""}${compacted ? "\nSession context was compacted during this step." : ""}`,
      text || "[Session produced no text output]",
      ...(compacted
        ? [
            "Session context was compacted and may have lost substantial context. Before continuing, use spin-talk to ask the session to re-read the relevant files, realign with the original task, estimate current progress, and create a new plan.",
          ]
        : []),
      `Session ID: ${dispatch.workerSessionID}.`,
      ...(contextWarning ? [contextWarning] : []),
    ].join("\n\n")
  }

  async function formatAgentEnvelope(senderSessionID: string, text: string) {
    let title = senderSessionID
    try {
      const session = await ctx.client.session.get({
        path: { id: senderSessionID },
      })
      if (session.data?.title) title = session.data.title
    } catch {
      // Best effort: fall back to the session ID when the title is unavailable.
    }

    const slug = title.match(/^\[[^\]\r\n]+\]/)?.[0]
    return [
      `${slug ? `${slug} ` : ""}Lead report. This message is not visible for the user. sessionId=${senderSessionID} title=${title}`,
      text || "[Lead produced no text output]",
      `Lead sessionID: ${senderSessionID}.`,
    ].join("\n\n")
  }

  function formatWorkerTarget(dispatch: {
    workerSessionID: string
    agent?: string
    model?: ModelOverride
  }) {
    const details = [
      `session=${dispatch.workerSessionID}`,
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

    if (!settledDispatch.relay) {
      return
    }

    const errorBody = `Error: ${message}\n\nThe result could not be recovered. Send your next instruction when ready.`

    try {
      await relayToLead(settledDispatch.leadSessionID, {
        noReply: true,
        text: formatWorkerResult(
          settledDispatch,
          errorBody,
          undefined,
          undefined,
          wasCompacted,
          "Step failed.",
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
        "Result did not become available within the retry deadline.",
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
          "Session completed but no assistant message became available.",
        )
        return
      }

      const settledDispatch = removeActiveDispatch(sessionID, activeDispatch)
      if (!settledDispatch) return

      if (!settledDispatch.relay) {
        compactedWorkers.delete(sessionID)
        if (leadSessions.has(sessionID)) {
          await checkLeadContext(sessionID)
        }
        return
      }

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
          ? `${text}\n\nSession error: ${JSON.stringify(latestInfo.error)}`
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

      await relayToLead(settledDispatch.leadSessionID, {
        noReply: !shouldContinue,
        text: shouldContinue
          ? `${payload}\n\nUser is unaware of this message. Decide next step: dispatch again, ask user, or stop.`
          : `${payload}\n\nUser is unaware of this message. Stopping here.${settledDispatch.comm === "async" ? ` Reached maxTurns=${settledDispatch.maxTurns}.` : ""}`,
      })
    } catch (error) {
      void failActiveDispatch(
        sessionID,
        activeDispatch,
        error instanceof Error
          ? error.message
          : "Failed to read session messages.",
      )
    }
  }

  // Mirror the worker context notices for lead sessions: on idle,
  // check the lead's own context size and inject a silent notice when
  // a threshold is crossed (same crossing semantics as worker notices).
  async function checkLeadContext(sessionID: string) {
    try {
      const messages = await ctx.client.session.messages({
        path: { id: sessionID },
      })

      const assistantMessages = messages.data.filter(isCompletedAssistantMessage)
      const latest = assistantMessages[assistantMessages.length - 1]
      if (!latest) return

      const tokens = (latest.info as AssistantMessageInfo).tokens
      if (!tokens) return

      const totalTokens =
        (tokens.input ?? 0) +
        (tokens.output ?? 0) +
        (tokens.cache?.read ?? 0) +
        (tokens.cache?.write ?? 0)
      const stepped = Math.floor(totalTokens / 50000) * 50000
      if (stepped < 300000) return

      const hard = stepped >= 500000
      await sendPrompt(sessionID, {
        noReply: true,
        text: hard
          ? `System Message. User doesn't see this:\n\nLead limit (user guidance): your session context reached tokens(${stepped / 1000}k) — past the trust boundary; this session is no longer reliable for coordination. Retire now: let in-flight workers finish or interrupt them, and once every worker is idle, write a generous handover file (including reasoning, evidence, decisions, rejected alternatives, open items, worker sessionIds, file paths, and validation results), spin exactly one successor lead session (spin-session with relay: false, e.g. title "[ORCH] successor") referencing that handover file. Then give the user a final summary including the successor sessionID and stop; the successor continues the work.\n\nEnd of System message.`
          : `System Message. User doesn't see this:\n\nLead notice (user guidance): your session context reached tokens(${stepped / 1000}k); coordination quality degrades at this size and every follow-up pays for retained context. Decide how to finish: either steer the current work to completion without taking on new work or new dispatches, or hand over to a successor lead. Hand over only once every worker is idle — active workers relay results to this session, and handing over mid-dispatch splits control between two leads — unless the user tells you to hand over earlier. Write a generous handover file (reasoning, evidence, decisions, rejected alternatives, open items, worker sessionIds, file paths, validation results), spin exactly one successor session (spin-session with relay: false) referencing that handover file, then tell the user you are handing over (with the successor session link) and stop. Make the handover generous; do not compress it to pointers alone or pasted file contents.\n\nEnd of System message.`,
      })
    } catch {
      // Best effort - context notices must never break the idle handler
    }
  }

  // Shared dispatch: validates the worker sessionID isn't the lead's
  // own, registers the dispatch, runs sync/async path, and returns the
  // standard "Prompt dispatched" message. Used by both spin-session (after it
  // creates a session) and spin-talk.
  const dispatchToWorker = async (
    workerSessionID: string,
    args: {
      text: string
      title?: string
      agent?: string
      model?: string
      comm?: "sync" | "async" | "off"
      relay?: boolean
      envelope?: boolean
    },
    toolCtx: { sessionID: string },
  ): Promise<string> => {
    leadSessions.add(toolCtx.sessionID)

    if (workerSessionID === toolCtx.sessionID) {
      throw new Error("Target sessionID must be different from current session.")
    }

    if (ceoSessions.has(workerSessionID)) {
      // CEO sessions are user-driven hubs: deliver the escalation silently and
      // never wake them. The CEO reads pending reports on its next user turn.
      if (!args.text) throw new Error("text is required.")
      const text = args.envelope
        ? await formatAgentEnvelope(toolCtx.sessionID, args.text)
        : args.text
      await deliverToCeo(workerSessionID, {
        text,
        agent: args.agent,
        model: parseModelOverride(args.model),
      })
      return `Report delivered silently to CEO session ${workerSessionID}. It will be read when the CEO next runs.`
    }

    const existingDispatch = activeDispatches.get(workerSessionID)
    if (
      existingDispatch &&
      existingDispatch.leadSessionID !== toolCtx.sessionID
    ) {
      throw new Error(
        `Session ${workerSessionID} is already controlled by another session.`,
      )
    }

    if (existingDispatch) {
      throw new Error(
        `Session ${workerSessionID} is still busy. Wait for its next relayed result before sending another prompt.`,
      )
    }

    if (!args.text) {
      throw new Error("text is required.")
    }

    abortedWorkers.delete(workerSessionID)

    const relay = args.relay ?? true
    const model = parseModelOverride(args.model)
    const comm = args.comm ?? "async"
    const maxTurns = 50

    if (!relay && comm === "sync") {
      throw new Error('relay: false cannot be combined with comm: "sync".')
    }

    const sessionTitle =
      args.title ??
      (await ctx.client.session.get({ path: { id: workerSessionID } })).data.title
    const workerSlug = sessionTitle.match(/^\[[^\]\r\n]+\]/)?.[0]

    const pendingDispatch: PendingDispatch = {
      leadSessionID: toolCtx.sessionID,
      workerSessionID,
      workerSlug,
      text: args.text,
      agent: args.agent,
      model,
      comm,
      maxTurns,
      relay,
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

    if (!pendingDispatch.relay) {
      // Detached: fire without awaiting the worker's turn. Awaiting
      // sendPrompt blocks the lead's tool call until idle.
      // Registration stays so the busy guard and the silent
      // idle/error settlement keep working.
      sendPrompt(workerSessionID, {
        agent: pendingDispatch.agent,
        model: pendingDispatch.model,
        text: pendingDispatch.text,
      }).catch((error) => {
        activeDispatches.delete(workerSessionID)
        const message = error instanceof Error ? error.message : String(error)
        // Nowhere to relay; log best-effort so failures stay visible.
        void ctx.client.app.log({
          body: {
            service: "opencode-spin",
            level: "error",
            message: `Detached dispatch to ${workerSessionID} failed: ${message}`,
            extra: { workerSessionID },
          },
        }).catch(() => {
          // Silently fail - plugin should not loop on notification errors
        })
      })

      return `Prompt dispatched to detached session. ${formatWorkerTarget(pendingDispatch)}. Results will not be relayed back to this session.`
    }

    sendPrompt(workerSessionID, {
      agent: pendingDispatch.agent,
      model: pendingDispatch.model,
      text: pendingDispatch.text,
    }).catch(async (error) => {
      activeDispatches.delete(workerSessionID)

      const message = error instanceof Error ? error.message : String(error)

      try {
        await relayToLead(pendingDispatch.leadSessionID, {
          noReply: true,
          text: `Dispatch failed. ${formatWorkerTarget(pendingDispatch)}\n\n${message}\n\nSession: ${pendingDispatch.workerSessionID}.`,
        })
      } catch {
        // Silently fail - plugin should not loop on notification errors
      }
    })

    return `Prompt dispatched to session. ${formatWorkerTarget(pendingDispatch)}. You will be notified when the step is complete. You can stop now.`
  }

  const autoArchiveWorkerSessions = false

  const archiveSession = async (sessionID: string) => {
    try {
      await ctx.client.session.update({
        path: { id: sessionID },
        body: { time: { archived: Date.now() } } as any,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      void ctx.client.app.log({
        body: {
          service: "opencode-spin",
          level: "warn",
          message: `Failed to archive worker session ${sessionID}: ${message}`,
          extra: { sessionID },
        },
      }).catch(() => {})
    }
  }

  const createWorkerSession = async (title: string | undefined) => {
    const newSession = await ctx.client.session.create({
      body: title ? { title } : {},
    })
    if (autoArchiveWorkerSessions) {
      await archiveSession(newSession.data.id)
    }
    return newSession.data.id
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
    config: (config: any) => {
      const skillsPath = join(dirname(fileURLToPath(import.meta.url)), "../skills")
      config.skills ??= {}
      config.skills.paths ??= []
      if (!config.skills.paths.includes(skillsPath)) {
        config.skills.paths.push(skillsPath)
      }
    },

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

        // CEO drain: on a user-driven turn end, deliver reports queued while
        // the CEO was busy. Deliveries are noReply: true, so they never wake
        // the CEO into another turn.
        if (ceoSessions.has(sessionID)) {
          const queue = ceoQueue.get(sessionID)
          if (queue && queue.length > 0) {
            ceoQueue.delete(sessionID)
            for (const item of queue) {
              await deliverToCeo(sessionID, item)
            }
          }
        }

        if (!activeDispatches.has(sessionID)) {
          if (leadSessions.has(sessionID)) {
            await checkLeadContext(sessionID)
          }
          return
        }

        const pendingDispatch = activeDispatches.get(sessionID)!
        if (pendingDispatch.comm === "sync") {
          await inspectWorkerResult(sessionID)
          return
        }

        // Deferred idle check: do not block the event loop so a trailing
        // session.error can remove the dispatch or arm the swallow first.
        // Exactly one silent notice per worker still comes from the error path.
        if (!pendingDispatch.inspecting) {
          void (async () => {
            await new Promise((resolve) => setTimeout(resolve, workerIdleSettleMs))
            if (activeDispatches.get(sessionID) !== pendingDispatch) return
            if (abortedWorkers.has(sessionID)) return
            await inspectWorkerResult(sessionID)
          })()
        }
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
          : "Unknown session error"

        const waiter = syncWaiters.get(sessionID)
        if (waiter) {
          syncWaiters.delete(sessionID)
          waiter.reject(new Error(errorLabel))
          return
        }

        if (!activeDispatch.relay) {
          return
        }

        const errorBody = `Error: ${errorLabel}\n\nThe session has been aborted. Send your next instruction when ready.`

        try {
          await relayToLead(activeDispatch.leadSessionID, {
            noReply: true,
            text: formatWorkerResult(
              activeDispatch,
              errorBody,
              undefined,
              undefined,
              wasCompacted,
          "Step failed.",
            ),
          })
        } catch {
          // Silently fail - plugin should not loop on notification errors
        }
      }
    },

    tool: {
      "spin-session": tool({
        description: `Create a new child session and dispatch the first prompt.

Use this to start a new session. To send a follow-up to an existing session, use spin-talk with that session's sessionID.

Returns the standard "Prompt dispatched" status. The result is relayed back when the session goes idle.
`,

        args: {
          text: tool.schema.string().describe("The prompt to send"),
          model: tool.schema
            .string()
            .describe('Model "provider/model" form, e.g. "github-copilot/gpt-5.6-luna"'),
          agent: tool.schema
            .string()
            .optional()
            .describe(
              "Optional AGENT SELECTION: only set agent if user asks for it. Available agents: ${agentList}",
            ),
          title: tool.schema
            .string()
            .optional()
            .describe("Human-readable label for the new child session. Prefix with slug in brackets, such as [WRK]."),
          relay: tool.schema
            .boolean()
            .optional()
            .describe(
              "Whether to relay results back to this lead session. Set to false when spawning a successor lead or detached session. Default: true",
            ),
          ...(ENABLE_ALL_COMM_MODES
            ? {
                comm: tool.schema
                  .enum(["sync", "async", "off"])
                  .optional()
                  .describe(
                    'Communication mode: "sync" blocks until session goes idle, "async" relays result later, "off" relays result, but you will see it when user allows it. Default: "async"',
                  ),
              }
            : {}),
          ceo: tool.schema
            .boolean()
            .optional()
            .describe("Enable CEO mode for this session. Session relays are queued while CEO is busy processing a previous relay."),
        },

        async execute(args, toolCtx) {
          return withErrorToast("Session operation failed", async () => {
            if (args.ceo) ceoSessions.add(toolCtx.sessionID)
            const sessionID = await createWorkerSession(args.title)
            return await dispatchToWorker(sessionID, args, toolCtx)
          })
        },
      }),

      "spin-talk": tool({
        description: `Send a follow-up prompt to an existing session.

Use this for every step after the first. To create a new session, use spin-session instead.

Returns the standard "Prompt dispatched" status. The result is relayed back when the session goes idle.
`,

        args: {
          sessionID: tool.schema
            .string()
            .describe(
              "Existing session ID (must start with 'ses'). Use the ID returned from a previous spin-session or spin-talk call. Not a semantic name or title.",
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
                    'Communication mode: "sync" blocks until session goes idle, "async" relays result later, "off" relays result, but you will see it when user allows it. Default: "async"',
                  ),
              }
            : {}),
          ceo: tool.schema
            .boolean()
            .optional()
            .describe("Enable CEO mode for this session. Session relays are queued while CEO is busy processing a previous relay."),
          envelope: tool.schema
            .boolean()
            .optional()
            .describe(
              "Wrap this message as an inter-agent lead report (used when escalating to the CEO). Default: false",
            ),
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

      "spin-box": tool({
        description: `A boxed agent is a detached one-shot session, hidden from the default session list but still openable and promptable by the user.

Runs one prompt asynchronously with agent/model override. The reply arrives as a relay when the child goes idle, so stop and wait for it. While it runs the child is tracked, and concurrent prompts to it are rejected.

Usage: only when the user asks for a box, or when the lead needs a one-shot Scout call without asking the user.
`,

        args: {
          text: tool.schema.string().describe("The prompt to send"),
          model: tool.schema
            .string()
            .describe('Model "provider/model" form, e.g. "github-copilot/gpt-5.4-mini". Prefer cheap model.'),
          agent: tool.schema
            .string()
            .optional()
            .describe("Optional AGENT SELECTION: only set agent if user asks for it. Available agents: ${agentList}"),
          title: tool.schema
            .string()
            .optional()
            .describe("Human-readable label for the child session."),
        },

        async execute(args, toolCtx) {
          return withErrorToast("Session operation failed", async () => {
            const sessionID = await createWorkerSession(args.title)
            return await dispatchToWorker(sessionID, { ...args, relay: true }, toolCtx)
          })
        },
      }),

      "spin-interrupt": tool({
        description: `Abort an active session.

Stops dispatches in progress and removes queued prompts for the session. Requires the actual session ID returned from a previous spin-session or spin-talk call.

- sessionID: child session ID (starts with "ses")
- Aborts in-progress dispatch (if controlled by this session) and rejects any sync waiter
- Removes queued prompts for the session across all dispatchers
- Marks the session so upcoming idle events are swallowed

EXAMPLE:

   # ABORT A SESSION
   spin-interrupt({
     sessionID: "ses_abc123xyz"
   })
`,

        args: {
          sessionID: tool.schema
            .string()
            .describe(
              "Existing session ID (must start with 'ses'). Use the ID returned from a previous spin-session or spin-talk call.",
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
              activeDispatch.leadSessionID !== toolCtx.sessionID
            ) {
              throw new Error(`Session ${workerSessionID} is controlled by another session.`)
            }

            if (!activeDispatch) {
              return `Session ${workerSessionID} has no active dispatch; nothing to interrupt.`
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
              waiter.reject(new Error("Session interrupted by dispatcher"))
            } else if (activeDispatch.relay) {
              const interruptBody = `Session was interrupted.\n\nThe session has been aborted. Send your next instruction when ready.`
              try {
                await relayToLead(activeDispatch.leadSessionID, {
                  noReply: true,
                  text: formatWorkerResult(
                    activeDispatch,
                    interruptBody,
                    undefined,
                    undefined,
                    wasCompacted,
                    "Step interrupted.",
                  ),
                })
              } catch {
                // Silently fail - plugin should not loop on notification errors
              }
            }

            return `Session ${workerSessionID} interrupted.`
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

      "spin-id": tool({
        description: `Return this session's own ID.

Use it to learn the session ID you must hand to leads (or any inter-agent recipient) so they can report back to you. Copy the ID verbatim; never invent or abbreviate it.
`,

        args: {},

        async execute(_args, toolCtx) {
          return `Session ID: ${toolCtx.sessionID}`
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
