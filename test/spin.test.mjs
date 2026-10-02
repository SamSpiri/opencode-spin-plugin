// Deterministic regression suite for the relay dispatch lifecycle
// (docs/relay-premature-idle.md). Mocked ctx + subscribed events; no network,
// no LLM. Production timers run at real durations on a virtual clock.
// Run: bun run test/spin.test.mjs
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const PARENT = "ses_parent"
const realInfo = console.info
const realSetImmediate = globalThis.setImmediate
const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout
const realNow = Date.now

// Import dependencies with real timers before the clock is enabled.
const MODULE = process.env.SPIN_MODULE ?? join(REPO, "index.ts")
const { default: plugin } = await import(MODULE)

let vnow = 1_000_000
let tseq = 0
let nextTimerId = 1
const timers = []
globalThis.setTimeout = (fn, ms = 0, ...args) => {
  const id = nextTimerId++
  timers.push({ id, at: vnow + Math.max(0, Number(ms) || 0), fn, args, seq: tseq++ })
  return id
}
globalThis.clearTimeout = (id) => {
  const i = timers.findIndex((t) => t.id === id)
  if (i >= 0) timers.splice(i, 1)
}
Date.now = () => vnow

const drain = async () => {
  for (let i = 0; i < 4; i++) await new Promise((r) => realSetImmediate(r))
}
const advance = async (ms) => {
  const target = vnow + ms
  for (let fired = 0; fired < 10000; fired++) {
    await drain()
    let next = null
    for (const t of timers) {
      if (t.at <= target && (!next || t.at < next.at || (t.at === next.at && t.seq < next.seq))) next = t
    }
    if (!next) { vnow = target; await drain(); return }
    timers.splice(timers.indexOf(next), 1)
    vnow = next.at
    next.fn(...next.args)
  }
  throw new Error(`advance(${ms}) exceeded the timer budget`)
}
const flush = () => advance(0)

function makeHarness() {
  const q = { items: [], wake: null, closed: false }
  const prompts = []
  const messages = {}
  const created = []
  const held = []
  let parentFailures = 0
  let contextFailures = 0
  let holdMode = "none"
  let heldCount = 0
  let holdContext = false
  let releaseContext = null

  const events = {
    push(...es) { q.items.push(...es); if (q.wake) { const w = q.wake; q.wake = null; w() } },
    async *iterate() {
      while (!q.closed) {
        if (!q.items.length) await new Promise((r) => (q.wake = r))
        while (q.items.length) yield q.items.shift()
      }
    },
    close() { q.closed = true; if (q.wake) { const w = q.wake; q.wake = null; w() } },
  }

  const ctx = {
    location: { directory: REPO },
    agent: { list: async () => ({ data: [] }) },
    skill: { transform: async (f) => f({ add() {} }) },
    tool: { transform: async (f) => f({ namespace() {}, add(t) { ctx._t[t.name] = t } }) },
    session: {
      switchAgent: async () => {},
      switchModel: async () => {},
      async prompt(i) {
        const rec = { id: i.id, text: i.text, sessionID: i.sessionID, resume: i.resume, accepted: false }
        prompts.push(rec)
        if (i.sessionID === PARENT) {
          if (parentFailures > 0) { parentFailures--; throw new Error("simulated relay failure") }
          if (holdMode === "all" || (holdMode === "first" && heldCount === 0)) {
            heldCount++
            await new Promise((res, rej) => held.push({ res, rej }))
          }
        }
        rec.accepted = true
        return { id: i.id ?? "msg_auto", sessionID: i.sessionID }
      },
      get: async ({ sessionID }) => ({ id: sessionID, title: "[WRK] child", location: { directory: REPO } }),
      create: async () => { const id = `ses_child_${created.length + 1}`; created.push(id); return { id } },
      // Snapshot at call entry so a blocked read returns stale data, exposing
      // inspection that fails to re-arm.
      context: async ({ sessionID }) => {
        const snapshot = [...(messages[sessionID] ?? [])]
        if (holdContext) await new Promise((r) => (releaseContext = r))
        if (contextFailures > 0) { contextFailures--; throw new Error("simulated context read failure") }
        return snapshot
      },
      interrupt: async () => {},
    },
    event: { subscribe: () => events.iterate() },
    _t: {},
  }

  return {
    ctx, events, prompts, messages, created, held,
    childId: () => created[created.length - 1],
    relays: () => prompts.filter((p) => p.sessionID === PARENT),
    acceptedRelays: () => prompts.filter((p) => p.sessionID === PARENT && p.accepted),
    setParentFailures: (n) => { parentFailures = n },
    setContextFailures: (n) => { contextFailures = n },
    holdParent: () => { holdMode = "all" },
    holdFirstParent: () => { holdMode = "first" },
    resolveHeld: () => { for (const h of held.splice(0)) h.res() },
    holdContext: () => { holdContext = true },
    releaseContext: () => { holdContext = false; const r = releaseContext; releaseContext = null; r?.() },
  }
}

async function boot() {
  const h = makeHarness()
  console.info = () => {}
  try {
    h.cleanup = await plugin.setup(h.ctx)
  } finally {
    console.info = realInfo
  }
  return h
}
const stop = (h) => { h.cleanup?.(); h.events.close() }

const toolCtx = { sessionID: PARENT, signal: new AbortController().signal }
const started = (s) => ({ type: "session.execution.started", data: { sessionID: s } })
const succeeded = (s) => ({ type: "session.execution.succeeded", data: { sessionID: s } })
const failed = (s, error = "boom") => ({ type: "session.execution.failed", data: { sessionID: s, error: { message: error } } })
const interrupted = (s, reason = "user") => ({ type: "session.execution.interrupted", data: { sessionID: s, reason } })
const idle = (s) => ({ type: "session.idle", data: { sessionID: s } })
const bgShell = (key, s) => ({ type: "session.tool.success", data: { sessionID: s, metadata: { status: "running", truncated: false, shellID: key } } })
const bgSubagent = (childID, s) => ({ type: "session.tool.success", data: { sessionID: s, metadata: { status: "running", sessionID: childID, output: [] } } })
const shellDone = (key, s) => ({ type: "session.synthetic", data: { sessionID: s, text: `<shell id="${key}"/>`, metadata: { source: "shell", shellID: key, jobID: key, state: "completed", exit: 0 } } })
const subagentDone = (childID, s) => ({ type: "session.synthetic", data: { sessionID: s, text: "<subagent/>", metadata: { source: "subagent", childID, state: "completed" } } })
const amsg = (id, created, text) => ({ id, type: "assistant", time: { created, completed: created + 1 }, content: [{ type: "text", text }], tokens: { input: 10, output: 10 } })
const parts = (id, created, content) => ({ id, type: "assistant", time: { created, completed: created + 1 }, content, tokens: { input: 10, output: 10 } })
const streaming = (id, created, text) => ({ id, type: "assistant", time: { created }, content: [{ type: "text", text }], tokens: { input: 1, output: 1 } })
const dispatch = (h, text = "work") => h.ctx._t.session.execute({ text, title: "[WRK] child" }, toolCtx)
const talk = (h, c, text) => h.ctx._t.talk.execute({ sessionID: c, text }, toolCtx)
const body = (h, i = 0) => h.relays()[i]?.text ?? ""
const count = (text, marker) => text.split(marker).length - 1
const busy = async (h, c) => { try { await talk(h, c, "probe"); return false } catch { return true } }

let passed = 0
let failedTests = 0
function check(cond, label, extra) {
  if (cond) { passed++; console.log(`  ok   ${label}`) }
  else { failedTests++; console.log(`  FAIL ${label}${extra === undefined ? "" : ` (${JSON.stringify(extra)})`}`) }
}

const tests = []
const test = (name, fn) => tests.push([name, fn])

test("multi-message run relays every text part in order once (excludes reasoning/tool/pre-dispatch)", async () => {
  const h = await boot()
  try {
    await dispatch(h)
    const c = h.childId()
    const t0 = Date.now()
    h.messages[c] = [
      amsg("pre", t0 - 5000, "PRE_DISPATCH"),
      parts("m1", t0 + 100, [
        { type: "reasoning", text: "SECRET_REASONING" },
        { type: "text", text: "[[alpha]]" },
        { type: "tool", text: "TOOL_OUTPUT" },
        { type: "text", text: "[[alpha2]]" },
      ]),
      amsg("m2", t0 + 200, "[[beta]]"),
      amsg("m3", t0 + 300, "[[gamma]]"),
    ]
    h.events.push(started(c), succeeded(c))
    await advance(600)
    check(h.relays().length === 1, "exactly one relay", h.relays().length)
    const text = body(h)
    check(["[[alpha]]", "[[alpha2]]", "[[beta]]", "[[gamma]]"].every((m) => count(text, m) === 1), "all text parts once")
    check(text.indexOf("[[alpha]]") < text.indexOf("[[alpha2]]") && text.indexOf("[[alpha2]]") < text.indexOf("[[beta]]") && text.indexOf("[[beta]]") < text.indexOf("[[gamma]]"), "chronological order")
    check(!text.includes("PRE_DISPATCH") && !text.includes("SECRET_REASONING") && !text.includes("TOOL_OUTPUT"), "negative controls excluded")
    check(h.acceptedRelays().length === 1 && Boolean(h.relays()[0]?.id), "relay accepted with nonempty id")
  } finally { stop(h) }
})

test("background shell continuation defers relay until session.synthetic then relays once", async () => {
  const h = await boot()
  try {
    await dispatch(h)
    const c = h.childId()
    const t0 = Date.now()
    h.events.push(started(c), bgShell("sh_xs", c))
    h.messages[c] = [amsg("m1", t0 + 100, "[[phase1]]")]
    h.events.push(succeeded(c))
    await advance(600)
    check(h.relays().length === 0, "no relay while shell obligation pending", h.relays().length)
    h.events.push(shellDone("sh_xs", c))
    await advance(600)
    check(h.relays().length === 0, "no relay while continuation debt unconsumed", h.relays().length)
    h.events.push(started(c))
    h.messages[c].push(amsg("m2", t0 + 200, "[[phase2]]"))
    h.events.push(succeeded(c))
    await advance(600)
    check(h.relays().length === 1, "one relay after continuation", h.relays().length)
    check(body(h).includes("[[phase1]]") && body(h).includes("[[phase2]]"), "both phases relayed")
    check(body(h).indexOf("[[phase1]]") < body(h).indexOf("[[phase2]]"), "order preserved")
  } finally { stop(h) }
})

test("subagent continuation defers then relays", async () => {
  const h = await boot()
  try {
    await dispatch(h)
    const c = h.childId()
    const t0 = Date.now()
    h.events.push(started(c), bgSubagent("ses_gc", c))
    h.messages[c] = [amsg("m1", t0 + 100, "[[spawned]]")]
    h.events.push(succeeded(c))
    await advance(600)
    check(h.relays().length === 0, "no relay while subagent pending", h.relays().length)
    h.events.push(subagentDone("ses_gc", c), started(c))
    h.messages[c].push(amsg("m2", t0 + 200, "[[subagent result]]"))
    h.events.push(succeeded(c))
    await advance(600)
    check(h.relays().length === 1, "one relay after subagent", h.relays().length)
    check(body(h).includes("[[spawned]]") && body(h).includes("[[subagent result]]"), "both phases relayed")
  } finally { stop(h) }
})

test("repeated execution.succeeded/idle never duplicates the relay", async () => {
  const h = await boot()
  try {
    await dispatch(h)
    const c = h.childId()
    const t0 = Date.now()
    h.events.push(started(c))
    h.messages[c] = [amsg("m1", t0 + 100, "[[once]]")]
    h.events.push(succeeded(c), idle(c), succeeded(c), idle(c))
    await advance(600)
    check(h.relays().length === 1 && count(body(h), "[[once]]") === 1, "relayed once", h.relays().length)
    h.events.push(idle(c), succeeded(c))
    await advance(3000)
    check(h.relays().length === 1, "still once after repeated triggers", h.relays().length)
    check(!(await busy(h, c)), "dispatch retired, next talk accepted")
  } finally { stop(h) }
})

test("relay delivery failure retries idempotently with a stable id, then frees the dispatch", async () => {
  const h = await boot()
  try {
    h.setParentFailures(1)
    await dispatch(h)
    const c = h.childId()
    const t0 = Date.now()
    h.events.push(started(c))
    h.messages[c] = [amsg("m1", t0 + 100, "[[done result]]")]
    h.events.push(succeeded(c))
    await advance(600)
    check(h.relays().length === 1 && h.acceptedRelays().length === 0, "first attempt failed", h.relays().length)
    check(await busy(h, c), "dispatch retained after failed delivery")
    await advance(2000)
    const r = h.relays()
    check(r.length === 2 && h.acceptedRelays().length === 1, "retried once, second accepted", r.length)
    check(Boolean(r[0]?.id) && r[0].id === r[1]?.id, "retry reuses stable relay id")
    check(r.length === 2 && r[0]?.text === r[1]?.text && r.every((p) => p.text.includes("[[done result]]")), "retry resends identical frozen payload")
    check(!(await busy(h, c)), "dispatch available after successful retry")
  } finally { stop(h) }
})

test("relay retries are bounded to three attempts", async () => {
  const h = await boot()
  try {
    h.setParentFailures(9)
    await dispatch(h)
    const c = h.childId()
    const t0 = Date.now()
    h.events.push(started(c))
    h.messages[c] = [amsg("m1", t0 + 100, "[[never lands]]")]
    h.events.push(succeeded(c))
    await advance(600)
    await advance(2000)
    await advance(2000)
    const r = h.relays()
    check(r.length === 3, "exactly three attempts", r.length)
    check(Boolean(r[0]?.id) && r.every((p) => p.id === r[0].id), "all attempts share the id")
    await advance(20000)
    check(h.relays().length === 3, "no attempts after exhaustion", h.relays().length)
  } finally { stop(h) }
})

test("execution.failed yields exactly one error relay and clears the dispatch", async () => {
  const h = await boot()
  try {
    await dispatch(h)
    const c = h.childId()
    h.events.push(started(c), failed(c, "boom"))
    await flush()
    check(h.relays().length === 1 && body(h).includes("Step failed"), "one error relay", h.relays().length)
    h.events.push(started(c), succeeded(c))
    await advance(1200)
    check(h.relays().length === 1, "late success does not relay", h.relays().length)
    check(!(await busy(h, c)), "dispatch cleared after failure")
  } finally { stop(h) }
})

test("execution.interrupted yields exactly one error relay and clears the dispatch", async () => {
  const h = await boot()
  try {
    await dispatch(h)
    const c = h.childId()
    h.events.push(started(c), interrupted(c))
    await flush()
    check(h.relays().length === 1 && body(h).includes("Step failed"), "one error relay", h.relays().length)
    h.events.push(succeeded(c))
    await advance(1200)
    check(h.relays().length === 1, "no relay after clear", h.relays().length)
    check(!(await busy(h, c)), "dispatch cleared after interruption")
  } finally { stop(h) }
})

test("consecutive talk dispatches do not cross-contaminate output", async () => {
  const h = await boot()
  try {
    await dispatch(h)
    const c = h.childId()
    const t0 = Date.now()
    h.events.push(started(c))
    h.messages[c] = [amsg("m1", t0 + 100, "[[first result]]")]
    h.events.push(succeeded(c))
    await advance(600)
    check(h.relays().length === 1 && body(h).includes("[[first result]]"), "first relayed", h.relays().length)
    await talk(h, c, "second")
    h.messages[c].push(amsg("m2", Date.now() + 100, "[[second result]]"))
    h.events.push(started(c), succeeded(c))
    await advance(600)
    check(h.relays().length === 2, "two relays", h.relays().length)
    const second = body(h, 1)
    check(second.includes("[[second result]]") && !second.includes("[[first result]]"), "second relay is delta only")
  } finally { stop(h) }
})

test("empty-delta terminal execution does not wedge the dispatch", async () => {
  const h = await boot()
  try {
    h.holdParent()
    await dispatch(h)
    const c = h.childId()
    const t0 = Date.now()
    h.events.push(started(c))
    h.messages[c] = [amsg("m1", t0 + 100, "[[batch1]]")]
    h.events.push(succeeded(c))
    await advance(600)
    check(h.held.length === 1 && h.relays().length === 1, "batch1 relay in flight", h.held.length)
    h.events.push(started(c), succeeded(c))
    await flush()
    h.resolveHeld()
    await flush()
    await advance(600)
    check(h.relays().length === 1 && count(body(h), "[[batch1]]") === 1, "no extra relay from empty delta", h.relays().length)
    check(!(await busy(h, c)), "dispatch retired after empty delta")
  } finally { stop(h) }
})

test("incomplete newer assistant message does not retire early, relays delta once it completes", async () => {
  const h = await boot()
  try {
    h.holdFirstParent()
    await dispatch(h)
    const c = h.childId()
    const t0 = Date.now()
    h.events.push(started(c))
    h.messages[c] = [amsg("m1", t0 + 100, "[[A]]")]
    h.events.push(succeeded(c))
    await advance(600)
    check(h.held.length === 1 && h.relays().length === 1, "batch A relay in flight", h.held.length)
    h.events.push(started(c), succeeded(c))
    h.messages[c].push(streaming("m2", t0 + 200, "[[B]]"))
    h.resolveHeld()
    await advance(600)
    check(h.relays().length === 1, "no early relay while B is incomplete", h.relays().length)
    check(await busy(h, c), "dispatch retained while B is incomplete")
    h.messages[c][1].time.completed = t0 + 300
    await advance(600)
    check(h.relays().length === 2, "B relayed once after it completes", h.relays().length)
    check(body(h, 1).includes("[[B]]") && !body(h, 1).includes("[[A]]"), "delta contains only B")
    check(!(await busy(h, c)), "dispatch retired after the delta relay")
  } finally { stop(h) }
})

test("incomplete newer assistant message that never completes fails after the bounded window", async () => {
  const h = await boot()
  try {
    h.holdFirstParent()
    await dispatch(h)
    const c = h.childId()
    const t0 = Date.now()
    h.events.push(started(c))
    h.messages[c] = [amsg("m1", t0 + 100, "[[A]]")]
    h.events.push(succeeded(c))
    await advance(600)
    h.events.push(started(c), succeeded(c))
    h.messages[c].push(streaming("m2", t0 + 200, "[[B]]"))
    h.resolveHeld()
    await flush()
    let guard = 0
    while (!h.relays().some((p) => p.text.includes("retry limit")) && guard++ < 20) await advance(600)
    const errors = h.relays().filter((p) => p.text.includes("Step failed"))
    check(errors.length === 1 && errors[0].text.includes("retry limit"), "one bounded error relay", h.relays().length)
    check(h.relays().length === 2, "incomplete message never relayed", h.relays().length)
    check(!(await busy(h, c)), "dispatch retired after bounded failure")
  } finally { stop(h) }
})

test("transient context-read rejection re-arms and relays the result", async () => {
  const h = await boot()
  try {
    h.setContextFailures(1)
    await dispatch(h)
    const c = h.childId()
    const t0 = Date.now()
    h.events.push(started(c))
    h.messages[c] = [amsg("m1", t0 + 100, "[[R]]")]
    h.events.push(succeeded(c))
    await advance(600)
    check(h.relays().length === 0, "no relay on the failed read", h.relays().length)
    check(await busy(h, c), "dispatch retained after transient read failure")
    await advance(600)
    check(h.relays().length === 1 && body(h).includes("[[R]]"), "relays after the retry", h.relays().length)
    check(!(await busy(h, c)), "dispatch retired after relay")
  } finally { stop(h) }
})

test("persistent context-read rejection yields exactly one error relay and retires", async () => {
  const h = await boot()
  try {
    h.setContextFailures(99)
    await dispatch(h)
    const c = h.childId()
    const t0 = Date.now()
    h.events.push(started(c))
    h.messages[c] = [amsg("m1", t0 + 100, "[[R]]")]
    h.events.push(succeeded(c))
    let guard = 0
    while (!h.relays().some((p) => p.text.includes("retry limit")) && guard++ < 20) await advance(600)
    check(h.relays().filter((p) => p.text.includes("Step failed")).length === 1, "one error relay", h.relays().length)
    check(h.relays().every((p) => !p.text.includes("[[R]]")), "result never relayed")
    check(!(await busy(h, c)), "dispatch retired after bounded failure")
  } finally { stop(h) }
})

test("deadline during in-flight result delivery still delivers the error and retires", async () => {
  const h = await boot()
  try {
    h.holdFirstParent()
    await dispatch(h)
    const c = h.childId()
    const t0 = Date.now()
    h.events.push(started(c))
    h.messages[c] = [amsg("m1", t0 + 100, "[[phase1]]")]
    h.events.push(succeeded(c))
    await advance(600)
    check(h.held.length === 1 && h.acceptedRelays().length === 0, "result relay in flight, not accepted", h.held.length)
    await advance(36_000_000)
    const errors = () => h.acceptedRelays().filter((p) => p.text.includes("Step failed"))
    check(errors().length === 1, "deadline error relay accepted", h.acceptedRelays().length)
    h.resolveHeld()
    await advance(20000)
    check(errors().length === 1 && h.relays().length === 2, "resolved result relay triggers no stale retry", h.relays().length)
    check(!(await busy(h, c)), "dispatch retired by deadline")
  } finally { stop(h) }
})

test("interruption during in-flight result delivery still delivers exactly one error", async () => {
  const h = await boot()
  try {
    h.holdFirstParent()
    await dispatch(h)
    const c = h.childId()
    const t0 = Date.now()
    h.events.push(started(c))
    h.messages[c] = [amsg("m1", t0 + 100, "[[phase1]]")]
    h.events.push(succeeded(c))
    await advance(600)
    check(h.held.length === 1, "result relay in flight", h.held.length)
    h.events.push(interrupted(c))
    await flush()
    const errors = () => h.acceptedRelays().filter((p) => p.text.includes("Step failed"))
    check(errors().length === 1, "one error relay while result in flight", h.relays().length)
    h.resolveHeld()
    await advance(20000)
    check(errors().length === 1, "resolved result relay does not add another error", errors().length)
    check(!(await busy(h, c)), "dispatch cleared after interruption")
  } finally { stop(h) }
})

test("disposal clears lifecycle timers and stops further work", async () => {
  {
    const h = await boot()
    await dispatch(h)
    const c = h.childId()
    const t0 = Date.now()
    h.events.push(started(c))
    h.messages[c] = [amsg("m1", t0 + 100, "[[pending]]")]
    h.events.push(succeeded(c))
    await flush()
    check(timers.length >= 2, "inspect + deadline timers armed", timers.length)
    stop(h)
    check(timers.length === 0, "cleanup cleared all timers", timers.length)
    await advance(600)
    check(h.relays().length === 0, "no relay after disposal")
  }
  {
    const h = await boot()
    h.setParentFailures(1)
    await dispatch(h)
    const c = h.childId()
    h.events.push(started(c), interrupted(c))
    await flush()
    check(h.relays().length === 1, "failed terminal-error attempt recorded", h.relays().length)
    stop(h)
    check(timers.length === 0, "cleanup cleared the terminal-error retry timer", timers.length)
    await advance(10000)
    check(h.relays().length === 1, "terminal-error retry did not fire after disposal", h.relays().length)
  }
  {
    const h = await boot()
    h.setParentFailures(1)
    await dispatch(h)
    const c = h.childId()
    const t0 = Date.now()
    h.events.push(started(c))
    h.messages[c] = [amsg("m1", t0 + 100, "[[pending result]]")]
    h.events.push(succeeded(c))
    await advance(600)
    check(h.relays().length === 1 && h.acceptedRelays().length === 0, "failed result attempt, retry scheduled", h.relays().length)
    check(timers.length >= 1, "result retry timer armed", timers.length)
    stop(h)
    check(timers.length === 0, "cleanup cleared the result retry timer", timers.length)
    await advance(10000)
    check(h.relays().length === 1, "result retry did not fire after disposal", h.relays().length)
  }
})

test("synthetic-before-tool.success fast ordering relays once", async () => {
  const h = await boot()
  try {
    await dispatch(h)
    const c = h.childId()
    const t0 = Date.now()
    h.events.push(started(c), shellDone("sh_fast", c), bgShell("sh_fast", c))
    h.messages[c] = [amsg("m1", t0 + 100, "[[fast done]]")]
    h.events.push(succeeded(c))
    await advance(600)
    check(h.relays().length === 1 && body(h).includes("[[fast done]]"), "settled obligation not re-armed; relayed once", h.relays().length)
  } finally { stop(h) }
})

test("stale inspection re-arms after a blocked context read", async () => {
  const h = await boot()
  try {
    h.holdContext()
    await dispatch(h)
    const c = h.childId()
    const t0 = Date.now()
    h.events.push(started(c))
    h.messages[c] = [amsg("m1", t0 + 100, "[[phase1]]")]
    h.events.push(succeeded(c))
    await advance(600)
    check(h.relays().length === 0, "no relay while context read blocked", h.relays().length)
    h.events.push(started(c))
    h.messages[c].push(amsg("m2", t0 + 200, "[[phase2]]"))
    h.events.push(succeeded(c))
    await flush()
    h.releaseContext()
    await flush()
    await advance(600)
    check(h.relays().length === 1, "stale inspection re-armed and relayed", h.relays().length)
    check(body(h).includes("[[phase1]]") && body(h).includes("[[phase2]]"), "both phases relayed after re-arm")
  } finally { stop(h) }
})

try {
  for (const [name, fn] of tests) {
    console.log(`\n# ${name}`)
    try {
      await fn()
    } catch (error) {
      failedTests++
      console.log(`  ERROR ${error?.message ?? error}`)
    }
    if (timers.length) {
      failedTests++
      console.log(`  FAIL ${timers.length} timer(s) leaked after case`)
      timers.length = 0
    }
  }
} finally {
  globalThis.setTimeout = realSetTimeout
  globalThis.clearTimeout = realClearTimeout
  Date.now = realNow
  console.info = realInfo
}
console.log(`\n${passed} checks passed, ${failedTests} failed`)
process.exitCode = failedTests ? 1 : 0
