/**
 * OpenCode Spin Plugin
 *
 * Child session orchestration with agent switching and cross-session control.
 *
  * Features:
 * - Spawn child sessions with initial prompts
 * - Send follow-up prompts to child sessions
 * - Relay child results back to parent sessions
 * - Multiple child sessions per parent
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

// CLEANUP 2026-09-13: removed Head queue (headSessions/headQueue/deliverToHead),
// sync/comm path (CommMode/syncWaiters/maxTurns/ENABLE_ALL_COMM_MODES) and
// head:true flag (formerly CEO). Rationale: wake:false delivery to a busy
// session is queued by opencode itself, so the plugin-side queue never fires;
// sync was never used. Revert to the commit before this message if
// wake:false-to-busy throws and the queue is needed again.

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

  type PendingDispatch = {
    parentSessionID: string
    childSessionID: string
    childSlug?: string
    text: string
    agent?: string
    model?: ModelOverride
    reportBack: boolean
  }

  type ActiveDispatch = PendingDispatch & {
    dispatchedAt: number
    deadlineAt: number
    turn: number
    lastChildMessageID?: string
    inspecting?: boolean
  }

  // Store active child dispatches waiting for child result
  const activeDispatches = new Map<string, ActiveDispatch>()

  // Child sessions that were interrupted; upcoming idle events are swallowed
  const abortedChildren = new Map<string, number>()
  // Sessions that compacted since their current dispatch started.
  const compactedChildren = new Set<string>()

  // Sessions that dispatched at least once (parents). Their own context
  // size is checked on idle.
  const parentSessions = new Set<string>()

  // Event types this plugin handles - early filter to skip noise
  const handledEventTypes = new Set(["session.idle", "session.error"])

  const childResultRetryTimeoutMs = 36000000

  // Number of session.idle events to swallow after an interrupt/abort.
  // OpenCode emits a pair (idle from abort + idle from session teardown) before the child truly settles.
  const abortedChildrenIdleSwallowCount = 2

  // Window for a late session.error to preempt a premature session.idle.
  // UI Stop can emit idle before error; the deferred idle check drops if
  // the error path removed the dispatch or armed the swallow in between.
  const childIdleSettleMs = 600

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
      wake?: boolean
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
    if (options.wake === false) body.noReply = true

    return ctx.client.session.prompt({
      path: { id: sessionID },
      body,
    })
  }

  async function relayToParent(
    parentSessionID: string,
    options: { text: string; wake?: boolean },
  ) {
    await sendPrompt(parentSessionID, options)
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

  function formatChildResult(
    dispatch: ActiveDispatch,
    text: string,
    usage?: { tokens?: AssistantMessageInfo["tokens"] },
    sessionSummary?: string,
    compacted = false,
    title = "Step complete.",
  ) {
    const details = [
      `sessionId=${dispatch.childSessionID}`,
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
      `${dispatch.childSlug ? `${dispatch.childSlug} ` : ""}${title} This message is Not visible for the user. ${details}${usageLine ? ` ${usageLine}` : ""}${sessionSummary ? ` ${sessionSummary}` : ""}${compacted ? "\nSession context was compacted during this step." : ""}`,
      text || "[Session produced no text output]",
      ...(compacted
        ? [
            "Session context was compacted and may have lost substantial context. Before continuing, use spin-talk to ask the session to re-read the relevant files, realign with the original task, estimate current progress, and create a new plan.",
          ]
        : []),
      `Session ID: ${dispatch.childSessionID}.`,
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
      `${slug ? `${slug} ` : ""}Child report. This message is not visible for the user. sessionId=${senderSessionID} title=${title}`,
      text || "[Child produced no text output]",
      `Child sessionID: ${senderSessionID}.`,
    ].join("\n\n")
  }

  function formatChildTarget(dispatch: {
    childSessionID: string
    agent?: string
    model?: ModelOverride
  }) {
    const details = [
      `session=${dispatch.childSessionID}`,
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

    // Clean compaction flag so a retry on this session isn't falsely
    // notified and the error relay can report it too.
    const wasCompacted = compactedChildren.delete(sessionID)

    if (!settledDispatch.reportBack) {
      return
    }

    const errorBody = `Error: ${message}\n\nThe result could not be recovered. Send your next instruction when ready.`

    try {
      await relayToParent(settledDispatch.parentSessionID, {
        wake: false,
        text: formatChildResult(
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

  async function inspectChildResult(sessionID: string) {
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
        .filter((message) => message.info.id !== activeDispatch.lastChildMessageID)

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

      if (!settledDispatch.reportBack) {
        compactedChildren.delete(sessionID)
        if (parentSessions.has(sessionID)) {
          await checkParentContext(sessionID)
        }
        return
      }

      const nextTurn = settledDispatch.turn + 1
      const text = extractTextParts(latest.parts)
      const latestInfo = latest.info as AssistantMessageInfo
      const sessionSummary = summarizeSessionContent(messages.data)

      const payload = formatChildResult(
        {
          ...settledDispatch,
          turn: nextTurn,
          lastChildMessageID: latestInfo.id,
        },
        latestInfo.error
          ? `${text}\n\nSession error: ${JSON.stringify(latestInfo.error)}`
          : text,
        { tokens: latestInfo.tokens },
        sessionSummary,
        compactedChildren.delete(sessionID),
      )

      await relayToParent(settledDispatch.parentSessionID, {
        wake: true,
        text: `${payload}\n\nUser is unaware of this message. Decide next step: dispatch again, ask user, or stop.`,
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

  // Mirror the child context notices for parent sessions: on idle,
  // check the parent's own context size and inject a silent notice when
  // a threshold is crossed (same crossing semantics as child notices).
  async function checkParentContext(sessionID: string) {
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
        wake: false,
        text: hard
          ? `System Message. User doesn't see this:\n\nSession limit (user guidance): your session context reached tokens(${stepped / 1000}k) — past the trust boundary; this session is no longer reliable for coordination. Retire now: let in-flight children finish or interrupt them, and once every child is idle, write a generous handover file (including reasoning, evidence, decisions, rejected alternatives, open items, child sessionIds, file paths, and validation results), spin exactly one successor session (spin-session with reportBack: false, e.g. title "[ORCH] successor") referencing that handover file. Then give the user a final summary including the successor sessionID and stop; the successor continues the work.\n\nEnd of System message.`
          : `System Message. User doesn't see this:\n\nSession notice (user guidance): your session context reached tokens(${stepped / 1000}k); coordination quality degrades at this size and every follow-up pays for retained context. Decide how to finish: either steer the current work to completion without taking on new work or new dispatches, or hand over to a successor. Hand over only once every child is idle — active children relay results to this session, and handing over mid-dispatch splits control between two parents — unless the user tells you to hand over earlier. Write a generous handover file (reasoning, evidence, decisions, rejected alternatives, open items, child sessionIds, file paths, validation results), spin exactly one successor session (spin-session with reportBack: false) referencing that handover file, then tell the user you are handing over (with the successor session link) and stop. Make the handover generous; do not compress it to pointers alone or pasted file contents.\n\nEnd of System message.`,
      })
    } catch {
      // Best effort - context notices must never break the idle handler
    }
  }

  // Shared dispatch: validates the child sessionID isn't the parent's
  // own, registers the dispatch, and returns the standard
  // "Prompt dispatched" message. Used by both spin-session (after it
  // creates a session) and spin-talk.
  const dispatchToChild = async (
    childSessionID: string,
    args: {
      text: string
      title?: string
      agent?: string
      model?: string
      reportBack?: boolean
      wake?: boolean
      envelope?: boolean
    },
    toolCtx: { sessionID: string },
  ): Promise<string> => {
    parentSessions.add(toolCtx.sessionID)

    if (childSessionID === toolCtx.sessionID) {
      throw new Error("Target sessionID must be different from current session.")
    }

    if (!args.text) {
      throw new Error("text is required.")
    }

    const text = args.envelope
      ? await formatAgentEnvelope(toolCtx.sessionID, args.text)
      : args.text
    const model = parseModelOverride(args.model)
    const wake = args.wake ?? true

    // wake:false implies reportBack:false: a silent report never wakes its
    // target, so there is no turn to relay back.
    const reportBack = wake ? (args.reportBack ?? true) : false
    if (!reportBack) {
      // Detached: fire without awaiting the child's turn and without
      // registering a dispatch. Awaiting sendPrompt blocks the parent's
      // tool call until idle.
      sendPrompt(childSessionID, {
        agent: args.agent,
        model,
        text,
        wake,
      }).catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        // Nowhere to relay; log best-effort so failures stay visible.
        void ctx.client.app.log({
          body: {
            service: "opencode-spin",
            level: "error",
            message: `Detached dispatch to ${childSessionID} failed: ${message}`,
            extra: { childSessionID },
          },
        }).catch(() => {
          // Silently fail - plugin should not loop on notification errors
        })
      })

      return `Prompt dispatched to detached session ${childSessionID}. Results will not be relayed back to this session.`
    }

    const existingDispatch = activeDispatches.get(childSessionID)
    if (
      existingDispatch &&
      existingDispatch.parentSessionID !== toolCtx.sessionID
    ) {
      throw new Error(
        `Session ${childSessionID} is already controlled by another session.`,
      )
    }

    if (existingDispatch) {
      throw new Error(
        `Session ${childSessionID} is still busy. Wait for its next relayed result before sending another prompt.`,
      )
    }

    abortedChildren.delete(childSessionID)

    const sessionTitle =
      args.title ??
      (await ctx.client.session.get({ path: { id: childSessionID } })).data.title
    const childSlug = sessionTitle.match(/^\[[^\]\r\n]+\]/)?.[0]

    const pendingDispatch: PendingDispatch = {
      parentSessionID: toolCtx.sessionID,
      childSessionID,
      childSlug,
      text,
      agent: args.agent,
      model,
      reportBack,
    }

    const activeDispatch: ActiveDispatch = {
      ...pendingDispatch,
      turn: 0,
      dispatchedAt: Date.now(),
      deadlineAt: Date.now() + childResultRetryTimeoutMs,
    }

    activeDispatches.set(childSessionID, activeDispatch)

    sendPrompt(childSessionID, {
      agent: pendingDispatch.agent,
      model: pendingDispatch.model,
      text: pendingDispatch.text,
    }).catch(async (error) => {
      activeDispatches.delete(childSessionID)

      const message = error instanceof Error ? error.message : String(error)

      try {
        await relayToParent(pendingDispatch.parentSessionID, {
          wake: false,
          text: `Dispatch failed. ${formatChildTarget(pendingDispatch)}\n\n${message}\n\nSession: ${pendingDispatch.childSessionID}.`,
        })
      } catch {
        // Silently fail - plugin should not loop on notification errors
      }
    })

    return `Prompt dispatched to session. ${formatChildTarget(pendingDispatch)}. You will be notified when the step is complete. You can stop now.`
  }

  const autoArchiveChildSessions = false

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
          message: `Failed to archive child session ${sessionID}: ${message}`,
          extra: { sessionID },
        },
      }).catch(() => {})
    }
  }

  const createChildSession = async (title: string | undefined) => {
    const newSession = await ctx.client.session.create({
      body: title ? { title } : {},
    })
    if (autoArchiveChildSessions) {
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

    // Hook: Listen for session and child events
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

        // Swallow idle events for an interrupted child
        const swallowCount = abortedChildren.get(sessionID)
        if (swallowCount !== undefined) {
          if (swallowCount <= 1) {
            abortedChildren.delete(sessionID)
          } else {
            abortedChildren.set(sessionID, swallowCount - 1)
          }
          return
        }

        if (!activeDispatches.has(sessionID)) {
          if (parentSessions.has(sessionID)) {
            await checkParentContext(sessionID)
          }
          return
        }

        const pendingDispatch = activeDispatches.get(sessionID)!

        // Deferred idle check: do not block the event loop so a trailing
        // session.error can remove the dispatch or arm the swallow first.
        // Exactly one silent notice per child still comes from the error path.
        if (!pendingDispatch.inspecting) {
          void (async () => {
            await new Promise((resolve) => setTimeout(resolve, childIdleSettleMs))
            if (activeDispatches.get(sessionID) !== pendingDispatch) return
            if (abortedChildren.has(sessionID)) return
            await inspectChildResult(sessionID)
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

        // Mark the child as aborted so the following idle events are ignored
        abortedChildren.set(sessionID, abortedChildrenIdleSwallowCount)
        removeActiveDispatch(sessionID, activeDispatch)

        // Clean compaction flag so a retry on this session isn't falsely notified.
        const wasCompacted = compactedChildren.delete(sessionID)

        const errorLabel = properties.error?.name
          ? `${properties.error.name}${properties.error.data?.message ? `: ${properties.error.data.message}` : ""}`
          : "Unknown session error"

        if (!activeDispatch.reportBack) {
          return
        }

        const errorBody = `Error: ${errorLabel}\n\nThe session has been aborted. Send your next instruction when ready.`

        try {
          await relayToParent(activeDispatch.parentSessionID, {
            wake: false,
            text: formatChildResult(
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
          reportBack: tool.schema
            .boolean()
            .optional()
            .describe(
              "Whether to relay results back to this session. Set to false when spawning a successor or detached session. Default: true (forced false when wake is false)",
            ),
          wake: tool.schema
            .boolean()
            .optional()
            .describe("Whether dispatching wakes the target session into a new turn. Set to false for silent reports that wait for the target's next user turn; implies reportBack false. Default: true"),
        },

        async execute(args, toolCtx) {
          return withErrorToast("Session operation failed", async () => {
            const sessionID = await createChildSession(args.title)
            return await dispatchToChild(sessionID, args, toolCtx)
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
          reportBack: tool.schema
            .boolean()
            .optional()
            .describe(
              "Whether to relay results back to this session. Set to false for detached fire-and-forget dispatches. Default: true (forced false when wake is false)",
            ),
          wake: tool.schema
            .boolean()
            .optional()
            .describe("Whether dispatching wakes the target session into a new turn. Set to false for silent reports that wait for the target's next user turn; implies reportBack false. Default: true"),
          envelope: tool.schema
            .boolean()
            .optional()
            .describe(
              "Wrap this message as an inter-agent child report (used when escalating to parent session). Default: false",
            ),
        },

        async execute(args, toolCtx) {
          return withErrorToast("Session operation failed", async () => {
            const validationError = validateSessionID(args.sessionID)
            if (validationError) throw new Error(validationError)
            return await dispatchToChild(args.sessionID, args, toolCtx)
          })
        },
      }),

      "spin-interrupt": tool({
        description: `Abort an active session.

Stops dispatches in progress and removes queued prompts for the session. Requires the actual session ID returned from a previous spin-session or spin-talk call.

- sessionID: child session ID (starts with "ses")
- Aborts in-progress dispatch (if controlled by this session)
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
            const childSessionID = args.sessionID

            const validationError = validateSessionID(childSessionID)
            if (validationError) {
              throw new Error(validationError)
            }

            const activeDispatch = activeDispatches.get(childSessionID)
            if (
              activeDispatch &&
              activeDispatch.parentSessionID !== toolCtx.sessionID
            ) {
              throw new Error(`Session ${childSessionID} is controlled by another session.`)
            }

            if (!activeDispatch) {
              return `Session ${childSessionID} has no active dispatch; nothing to interrupt.`
            }

            removeActiveDispatch(childSessionID, activeDispatch)
            abortedChildren.set(childSessionID, abortedChildrenIdleSwallowCount)
            // Consume compaction flag so a retry on this session isn't
            // falsely notified and the relay can report it.
            const wasCompacted = compactedChildren.delete(childSessionID)
            await ctx.client.session.abort({ path: { id: childSessionID } })

            if (activeDispatch.reportBack) {
              const interruptBody = `Session was interrupted.\n\nThe session has been aborted. Send your next instruction when ready.`
              try {
                await relayToParent(activeDispatch.parentSessionID, {
                  wake: false,
                  text: formatChildResult(
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

            return `Session ${childSessionID} interrupted.`
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

Use it to learn the session ID you must hand to another session (for example, a parent giving children the address to report back to). Copy the ID verbatim; never invent or abbreviate it.
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
        compactedChildren.add(input.sessionID)
      }
    },
  } as any
}
