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
 * @version 2.0.0
 * @license MIT
 * @author M. Adel Alhashemi
 * @see https://github.com/malhashemi/opencode-sessions
 */

import { readdir, readFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Plugin, Skill } from "@opencode/plugin"
import matter from "gray-matter"

async function loadSkills() {
  const directory = dirname(fileURLToPath(import.meta.url))
  let root = join(directory, "skills")
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    // Single-file install (plugins/spin.js) has no bundled skills dir;
    // skills come from the global skills dir instead. Never fall back to
    // ../skills there: that would re-register unrelated global skills.
    if (basename(directory) !== "dist") return []
    root = join(directory, "../skills")
    try {
      entries = await readdir(root, { withFileTypes: true })
    } catch {
      return []
    }
  }
  return Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const path = join(root, entry.name, "SKILL.md")
        const source = await readFile(path, "utf8")
        const parsed = matter(source)
        return {
          id: Skill.ID.make(entry.name),
          name: Skill.Name.make(
            typeof parsed.data.name === "string"
              ? parsed.data.name
              : entry.name,
          ),
          description:
            typeof parsed.data.description === "string"
              ? parsed.data.description
              : undefined,
          path: path as Skill.Info["path"],
          content: parsed.content.trim(),
        }
      }),
  )
}

export default Plugin.define({
  id: "spin",
  async setup(ctx) {
    const [{ data: agents }, skills] = await Promise.all([
      ctx.agent.list({ location: { directory: ctx.location.directory } }),
      loadSkills(),
    ])
    const agentList = agents
      .filter(
        (agent) =>
          !agent.hidden && (agent.mode === "primary" || agent.mode === "all"),
      )
      .map(
        (agent) =>
          `  • ${agent.id} - ${agent.description || "No description available"}`,
      )
      .join("\n")

    await ctx.skill.transform((editor) => {
      for (const skill of skills) editor.add(skill)
    })

    console.info(`[spin] loaded for ${ctx.location.directory}`)
    const eventController = new AbortController()

    type ModelOverride = { providerID: string; modelID: string }
    type SessionMessage = Awaited<
      ReturnType<typeof ctx.session.context>
    >[number]
    type AssistantMessage = Extract<SessionMessage, { type: "assistant" }>

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
      deadlineTimer?: ReturnType<typeof setTimeout>
      inspecting?: boolean
    }

    const activeDispatches = new Map<string, ActiveDispatch>()

    const abortedChildren = new Set<string>()
    const compactedChildren = new Set<string>()

    const parentSessions = new Set<string>()

    const childResultRetryTimeoutMs = 36000000

    const childIdleSettleMs = 600

    function validateSessionID(sessionID: string): string | null {
      if (!sessionID.startsWith("ses")) {
        return `Invalid session ID format. Session IDs must start with "ses" (e.g. "ses_abc123xyz"). Got: "${sessionID}". Use tools.spin.talk to send a follow-up to an existing session (pass the sessionID returned from tools.spin.session or tools.spin.talk). Semantic names like "spin-plane-redux" are not valid session IDs.`
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
        beforePrompt?: () => void
      },
      signal?: AbortSignal,
    ) {
      const requestOptions = signal ? { signal } : undefined
      if (options.wake !== false) {
        if (options.agent) {
          await ctx.session.switchAgent(
            { sessionID, agent: options.agent },
            requestOptions,
          )
        }
        if (options.model) {
          await ctx.session.switchModel(
            {
              sessionID,
              model: {
                providerID: options.model.providerID,
                id: options.model.modelID,
              },
            },
            requestOptions,
          )
        }
      }
      options.beforePrompt?.()
      return ctx.session.prompt(
        { sessionID, text: options.text, resume: options.wake !== false },
        requestOptions,
      )
    }

    async function relayToParent(
      parentSessionID: string,
      options: { text: string; wake?: boolean },
    ) {
      await sendPrompt(parentSessionID, options)
    }

    // The server's message shape drifts across versions; normalize defensively
    // so inspection never throws or silently matches nothing (both wedge the
    // dispatch with no relay). Mirrors the proven v1 mapping.
    type NormalizedMessage = {
      id?: string
      role?: string
      time: { created: number; completed?: number }
      tokens?: AssistantMessage["tokens"]
      error?: unknown
      parts: Array<{ type: string; text?: string }>
    }

    async function getSessionMessages(
      sessionID: string,
    ): Promise<NormalizedMessage[]> {
      const messages = await ctx.session.context({ sessionID })
      return messages.map((message: any) => ({
        id: message.id,
        role: message.type,
        time: message.time ?? { created: 0 },
        tokens: message.tokens,
        error: message.error,
        parts: message.content ?? [],
      }))
    }

    function extractTextParts(parts: NormalizedMessage["parts"]) {
      return parts
        .flatMap((part) =>
          part.type === "text" && typeof part.text === "string"
            ? [part.text.trim()]
            : [],
        )
        .filter(Boolean)
        .join("\n\n")
    }

    function summarizeSessionContent(messages: NormalizedMessage[]) {
      return `msgs(${messages.length})`
    }

    function isCompletedAssistantMessage(message: NormalizedMessage) {
      return (
        message.role === "assistant" && (message.time.created ?? 0) > 0
      )
    }

    function formatChildResult(
      dispatch: ActiveDispatch,
      text: string,
      usage?: { tokens?: AssistantMessage["tokens"] },
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
          contextWarning = `Context limit (user guidance): session context reached tokens(${stepped / 1000}k) — past the trust boundary. Output may still seem usable but is too polluted to rely on. Do not continue substantive work in this session; move anything important to a fresh session. Retired session remains queryable via tools.spin.talk for reference only.`
        } else if (stepped >= 300000) {
          contextWarning = `Context notice (user guidance): session context reached tokens(${stepped / 1000}k); output quality degrades at this size. Every follow-up also pays for retained context, so prefer a fresh session for a new substantive direction. If rotating, ask the retiring session for a generous handover file now. It should contain at least: reasoning, evidence, decisions, rejected alternatives, state, open questions, file paths, and validation results—not merely pointers or a compact brief. Retired session stays available via tools.spin.talk for quick clarifications.`
        }
      }

      return [
        `${dispatch.childSlug ? `${dispatch.childSlug} ` : ""}${title} This message is Not visible for the user. ${details}${usageLine ? ` ${usageLine}` : ""}${sessionSummary ? ` ${sessionSummary}` : ""}${compacted ? "\nSession context was compacted during this step." : ""}`,
        text || "[Session produced no text output]",
        ...(compacted
          ? [
              "Session context was compacted and may have lost substantial context. Before continuing, use tools.spin.talk to ask the session to re-read the relevant files, realign with the original task, estimate current progress, and create a new plan.",
            ]
          : []),
        `Session ID: ${dispatch.childSessionID}.`,
        ...(contextWarning ? [contextWarning] : []),
      ].join("\n\n")
    }

    async function formatAgentEnvelope(senderSessionID: string, text: string) {
      let title = senderSessionID
      try {
        const session = await ctx.session.get({ sessionID: senderSessionID })
        if (session.title) title = session.title
      } catch {
        // Best effort: fall back to the session ID when the title is unavailable.
      }

      const slug = title.match(/^\[[^\]\r\n]+\]/)?.[0]
      return [
        `${slug ? `${slug} ` : ""}Inter-agent report. This message is not visible for the user. sessionId=${senderSessionID} title=${title}`,
        text || "[No report text]",
        `Sender sessionID: ${senderSessionID}.`,
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
      if (current.deadlineTimer) clearTimeout(current.deadlineTimer)
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

      try {
        const messages = await getSessionMessages(sessionID)

        const assistantMessages = messages.filter(
          (message) =>
            isCompletedAssistantMessage(message) &&
            message.time.created >= activeDispatch.dispatchedAt,
        )

        const latest = assistantMessages[assistantMessages.length - 1]
        if (!latest) {
          activeDispatch.inspecting = false
          console.info("[spin] child wait ended before a new assistant result", {
            childSessionID: sessionID,
            parentSessionID: activeDispatch.parentSessionID,
          })
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

        const text = extractTextParts(latest.parts)
        const sessionSummary = summarizeSessionContent(messages)

        const sessionError =
          typeof latest.error === "string"
            ? latest.error
            : latest.error && typeof latest.error === "object" && "message" in latest.error
              ? String((latest.error as { message?: unknown }).message)
              : undefined

        const payload = formatChildResult(
          settledDispatch,
          sessionError ? `${text}\n\nSession error: ${sessionError}` : text,
          { tokens: latest.tokens },
          sessionSummary,
          compactedChildren.delete(sessionID),
        )

        await relayToParent(settledDispatch.parentSessionID, {
          wake: true,
          text: `${payload}\n\nUser is unaware of this message. Decide next step: dispatch again, ask user, or stop.`,
        })
      } catch (error) {
        activeDispatch.inspecting = false
        console.error(`[spin] failed to inspect child ${sessionID}`, error)
      }
    }

    // Mirror the child context notices for parent sessions: on idle,
    // check the parent's own context size and inject a silent notice when
    // a threshold is crossed (same crossing semantics as child notices).
    async function checkParentContext(sessionID: string) {
      try {
        const messages = await getSessionMessages(sessionID)

        const assistantMessages = messages.filter(isCompletedAssistantMessage)
        const latest = assistantMessages[assistantMessages.length - 1]
        if (!latest) return

        const tokens = latest.tokens
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
            ? `System Message. User doesn't see this:\n\nSession limit (user guidance): your session context reached tokens(${stepped / 1000}k) — past the trust boundary; this session is no longer reliable for coordination. Retire now: let in-flight children finish or interrupt them, and once every child is idle, write a generous handover file (including reasoning, evidence, decisions, rejected alternatives, open items, child sessionIds, file paths, and validation results), spin exactly one successor session (tools.spin.session with reportBack: false, e.g. title "[ORCH] successor") referencing that handover file. Then give the user a final summary including the successor sessionID and stop; the successor continues the work.\n\nEnd of System message.`
            : `System Message. User doesn't see this:\n\nSession notice (user guidance): your session context reached tokens(${stepped / 1000}k); coordination quality degrades at this size and every follow-up pays for retained context. Decide how to finish: either steer the current work to completion without taking on new work or new dispatches, or hand over to a successor. Hand over only once every child is idle — active children relay results to this session, and handing over mid-dispatch splits control between two parents — unless the user tells you to hand over earlier. Write a generous handover file (reasoning, evidence, decisions, rejected alternatives, open items, child sessionIds, file paths, validation results), spin exactly one successor session (tools.spin.session with reportBack: false) referencing that handover file, then tell the user you are handing over (with the successor session link) and stop. Make the handover generous; do not compress it to pointers alone or pasted file contents.\n\nEnd of System message.`,
        })
      } catch {
        // Best effort - context notices must never break the idle handler
      }
    }

    // Shared dispatch: validates ownership and starts a child turn.
    const dispatchToChild = async (
      childSessionID: string,
      args: {
        text: string
        title?: string
        agent?: string
        model?: string
        reportBack?: boolean
        wake?: boolean
        escalate?: boolean
      },
      toolCtx: { sessionID: string; signal: AbortSignal },
    ): Promise<string> => {
      parentSessions.add(toolCtx.sessionID)

      if (childSessionID === toolCtx.sessionID) {
        throw new Error(
          "Target sessionID must be different from current session.",
        )
      }

      if (!args.text) {
        throw new Error("text is required.")
      }

      const text = args.escalate
        ? await formatAgentEnvelope(toolCtx.sessionID, args.text)
        : args.text
      const model = parseModelOverride(args.model)
      const wake = args.wake ?? true

      // wake:false implies reportBack:false: a silent report never wakes its
      // target, so there is no turn to relay back.
      const reportBack = wake ? (args.reportBack ?? true) : false
      if (!reportBack) {
        // Detached: start the target turn without tracking or relaying it.
        sendPrompt(
          childSessionID,
          {
            agent: args.escalate ? undefined : args.agent,
            model: args.escalate ? undefined : model,
            text,
            wake,
          },
          toolCtx.signal,
        ).catch((error) => {
          console.error(
            `[spin] detached dispatch to ${childSessionID} failed`,
            error,
          )
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
        (await ctx.session.get({ sessionID: childSessionID })).title ??
        childSessionID
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
        dispatchedAt: 0,
      }

      activeDispatches.set(childSessionID, activeDispatch)
      activeDispatch.deadlineTimer = setTimeout(() => {
        void failActiveDispatch(
          childSessionID,
          activeDispatch,
          "Result did not become available within the retry deadline.",
        )
      }, childResultRetryTimeoutMs)

      sendPrompt(
        childSessionID,
        {
          agent: args.escalate ? undefined : pendingDispatch.agent,
          model: args.escalate ? undefined : pendingDispatch.model,
          text: pendingDispatch.text,
          beforePrompt: () => {
            activeDispatch.dispatchedAt = Date.now()
          },
        },
        toolCtx.signal,
      ).catch(async (error) => {
        removeActiveDispatch(childSessionID, activeDispatch)

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

    const createChildSession = async (
      title: string | undefined,
      parentSessionID: string,
      signal: AbortSignal,
    ) => {
      const requestOptions = { signal }
      const parent = await ctx.session.get(
        { sessionID: parentSessionID },
        requestOptions,
      )
      return ctx.session.create(
        {
          ...(title ? { title } : {}),
          location: { directory: parent.location.directory },
        },
        requestOptions,
      )
    }

    async function handleEvent(
      event: Awaited<
        ReturnType<typeof ctx.event.subscribe>
      > extends AsyncIterable<infer E>
        ? E
        : never,
    ) {
      if (event.type === "session.compaction.started") {
        if (activeDispatches.has(event.data.sessionID)) {
          compactedChildren.add(event.data.sessionID)
        }
        return
      }

      // Turn-end trigger. This server emits session.execution.succeeded at
      // turn end; session.idle may never fire. Both feed the same
      // inspection, and the inspecting flag dedups back-to-back arrivals.
      if (
        event.type === "session.idle" ||
        event.type === "session.execution.succeeded"
      ) {
        const sessionID = event.data.sessionID
        if (abortedChildren.delete(sessionID)) return

        const pendingDispatch = activeDispatches.get(sessionID)
        if (!pendingDispatch) {
          if (parentSessions.has(sessionID)) await checkParentContext(sessionID)
          return
        }

        if (!pendingDispatch.inspecting) {
          void (async () => {
            await new Promise((resolve) =>
              setTimeout(resolve, childIdleSettleMs),
            )
            if (
              eventController.signal.aborted ||
              activeDispatches.get(sessionID) !== pendingDispatch ||
              abortedChildren.has(sessionID)
            )
              return
            await inspectChildResult(sessionID)
          })()
        }
        return
      }

      if (
        event.type !== "session.execution.failed" &&
        event.type !== "session.execution.interrupted"
      )
        return
      const sessionID = event.data.sessionID
      const activeDispatch = activeDispatches.get(sessionID)
      if (!activeDispatch) return

      abortedChildren.add(sessionID)
      removeActiveDispatch(sessionID, activeDispatch)
      const wasCompacted = compactedChildren.delete(sessionID)
      if (!activeDispatch.reportBack) return

      const errorLabel =
        event.type === "session.execution.failed"
          ? event.data.error.message
          : `Turn interrupted (${event.data.reason}).`
      try {
        await relayToParent(activeDispatch.parentSessionID, {
          wake: false,
          text: formatChildResult(
            activeDispatch,
            `Error: ${errorLabel}\n\nThe turn has been aborted. Send your next instruction when ready.`,
            undefined,
            undefined,
            wasCompacted,
            "Step failed.",
          ),
        })
      } catch {
        // Best effort; the parent can still inspect the child session.
      }
    }

    const sessionInput = {
      type: "object",
      properties: {
        text: { type: "string", description: "The prompt to send" },
        model: {
          type: "string",
          description:
            'Model "provider/model" form, e.g. "github-copilot/gpt-5.4-mini"',
        },
        agent: {
          type: "string",
          description: `Optional agent override. Set only when requested. Available agents:\n${agentList}`,
        },
        title: {
          type: "string",
          description: "Optional child title; [WRK] is recommended",
        },
        reportBack: {
          type: "boolean",
          description: "Relay the result to this session; defaults to true",
        },
        wake: {
          type: "boolean",
          description:
            "Start a turn in the target; false admits the prompt without resuming it",
        },
      },
      required: ["text"],
      additionalProperties: false,
    } as const

    const talkInput = {
      type: "object",
      properties: {
        sessionID: {
          type: "string",
          description: 'Child session ID beginning with "ses"',
        },
        text: { type: "string", description: "The prompt to send" },
        model: {
          type: "string",
          description:
            'Model "provider/model" form, e.g. "github-copilot/gpt-5.4-mini"',
        },
        agent: {
          type: "string",
          description: `Optional agent override. Set only when requested. Available agents:\n${agentList}`,
        },
        reportBack: {
          type: "boolean",
          description: "Relay the result to this session; defaults to true",
        },
        wake: {
          type: "boolean",
          description:
            "Start a turn in the target; false admits the prompt without resuming it",
        },
        escalate: {
          type: "boolean",
          description:
            "Wrap this as a report to a parent; use only when reporting upward",
        },
      },
      required: ["sessionID", "text"],
      additionalProperties: false,
    } as const

    const interruptInput = {
      type: "object",
      properties: {
        sessionID: {
          type: "string",
          description: 'Child session ID beginning with "ses"',
        },
      },
      required: ["sessionID"],
      additionalProperties: false,
    } as const

    await ctx.tool.transform((editor) => {
      editor.namespace({
        name: "spin",
        description: "Create, continue, and interrupt child sessions",
      })
      editor.add({
        name: "session",
        description: "Create a child session and dispatch its first prompt.",
        input: sessionInput,
        options: { namespace: "spin", codemode: true },
        async execute(input, toolCtx) {
          const args = input as {
            text: string
            model: string
            agent?: string
            title?: string
            reportBack?: boolean
            wake?: boolean
          }
          if (!args.text.trim()) throw new Error("text is required.")
          parseModelOverride(args.model)
          const session = await createChildSession(
            args.title,
            toolCtx.sessionID,
            toolCtx.signal,
          )
          return { content: await dispatchToChild(session.id, args, toolCtx) }
        },
      })
      editor.add({
        name: "talk",
        description: "Send a follow-up prompt to an existing session.",
        input: talkInput,
        options: { namespace: "spin", codemode: true },
        async execute(input, toolCtx) {
          const args = input as {
            sessionID: string
            text: string
            model: string
            agent?: string
            reportBack?: boolean
            wake?: boolean
            escalate?: boolean
          }
          const validationError = validateSessionID(args.sessionID)
          if (validationError) throw new Error(validationError)
          if (!args.text.trim()) throw new Error("text is required.")
          parseModelOverride(args.model)
          return {
            content: await dispatchToChild(args.sessionID, args, toolCtx),
          }
        },
      })
      editor.add({
        name: "interrupt",
        description:
          "Interrupt a controlled child session while keeping it addressable for follow-ups.",
        input: interruptInput,
        options: { namespace: "spin", codemode: true },
        async execute(input, toolCtx) {
          const { sessionID } = input as { sessionID: string }
          const validationError = validateSessionID(sessionID)
          if (validationError) throw new Error(validationError)

          const activeDispatch = activeDispatches.get(sessionID)
          if (
            activeDispatch &&
            activeDispatch.parentSessionID !== toolCtx.sessionID
          ) {
            throw new Error(
              `Session ${sessionID} is controlled by another session.`,
            )
          }
          if (!activeDispatch)
            return {
              content: `Session ${sessionID} has no active dispatch; nothing to interrupt.`,
            }

          removeActiveDispatch(sessionID, activeDispatch)
          abortedChildren.add(sessionID)
          const wasCompacted = compactedChildren.delete(sessionID)
          await ctx.session.interrupt(
            { sessionID, resume: false },
            { signal: toolCtx.signal },
          )

          if (activeDispatch.reportBack) {
            try {
              await relayToParent(activeDispatch.parentSessionID, {
                wake: false,
                text: formatChildResult(
                  activeDispatch,
                  "Turn was interrupted.\nSend your next instruction when ready.",
                  undefined,
                  undefined,
                  wasCompacted,
                  "Turn interrupted.",
                ),
              })
            } catch {
              // Best effort; the child remains available for a follow-up.
            }
          }
          return { content: `Turn for session ${sessionID} was interrupted.` }
        },
      })
    })

    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({
          signal: eventController.signal,
        })) {
          try {
            await handleEvent(event)
          } catch (error) {
            console.error(`[spin] event ${event.type} failed`, error)
          }
        }
      } catch (error) {
        if (!eventController.signal.aborted)
          console.error("[spin] event stream failed", error)
      }
    })()

    return () => {
      eventController.abort()
      for (const dispatch of activeDispatches.values()) {
        if (dispatch.deadlineTimer) clearTimeout(dispatch.deadlineTimer)
      }
    }
  },
})
