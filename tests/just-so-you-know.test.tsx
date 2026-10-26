import type { On, SessionMessage } from "claude-code"
import type { Engine } from "claude-code/testing"
import { expect, mock, test } from "claude-code/testing"

declare function setTimeout(callback: (value?: unknown) => void, ms: number): unknown

const USAGE = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const SIDE_AGENT_REPLY = `learn: The page cache key leaves out the locale, so French visitors may get cached English pages.
tag: Heads up
explain:
**Cached pages ignore the visitor's language**
* The cache key is built from the URL alone.`
const LINE = "The page cache key leaves out the locale, so French visitors may get cached English pages."

function world(on: On, entries: Record<string, unknown> = {}) {
  const store = new Map(Object.entries(entries))
  on("store.get", (_$, e) => ({ value: store.get(e.key) }))
  on("store.set", (_$, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  const session = mock.session(on)
  const forks: string[] = []
  const toasts: string[] = []
  on("session.start", (_$, e) => ({ cwd: e.cwd }))
  on("session.id", () => ({ value: "s1" }))
  on("session.surfaces", () => ({ value: ["terminal"] }))
  on("command.register", () => ({ value: { command: "jsyk" } }))
  on("ui.invalidate", () => ({ value: undefined }))
  on("ui.toast", (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on("model.fork", (_$, e) => {
    forks.push(e.prompt)
    return { value: { isAnswered: true, text: SIDE_AGENT_REPLY, usage: USAGE } }
  })
  on("turn.step", async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: "", toolUses: [], stopReason: "end_turn" as const, usage: null }
  })
  on("turn.complete", (_$, e) => ({ text: e.answer }))
  const findings = () => {
    const stored = store.get("findings")
    return Array.isArray(stored) ? (stored as { line: string; verdict?: string; evidence?: string }[]) : []
  }
  return { session, forks, toasts, findings }
}

async function step($: Engine, turnId: string, index: number) {
  for await (const _chunk of $.turn.step({ turnId, index, model: "claude", messageCount: 2 })) {
  }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 100))

async function eventually($: Engine, isDone: () => boolean) {
  for (let tries = 0; tries < 400; tries++) {
    if (isDone()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error("the background check never finished")
}

test("a check on the 6th step shares the note with the main agent without asking", async ($, on) => {
  const { session, forks, toasts, findings } = world(on)
  await $.session.start({ cwd: "/work/shop", surface: "terminal", isInteractive: true })

  await step($, "t1", 5)
  await settle()
  expect(forks.length).toBe(0)

  await step($, "t1", 6)
  await eventually($, () => findings().length === 1)

  expect(forks.length).toBe(1)
  const rows = session.appended().map(row => JSON.stringify(row.message.content))
  expect(rows.some(row => row.includes("Here is a note offered by a side agent (Just So You Know)"))).toBe(true)
  expect(rows.some(row => row.includes(`Heads up · ${LINE}`))).toBe(true)
  const notices = session.appended().filter(row => row.message.type === "system")
  expect(notices.map(row => JSON.stringify(row.message.content))).toEqual([
    expect.stringContaining(`Just So You Know told the main agent: Heads up · ${LINE}`),
  ])
  expect(toasts).toEqual([`Just So You Know told the main agent: ${LINE}`])

  await step($, "t1", 12)
  await step($, "t2", 6)
  await settle()
  expect(forks.length).toBe(1)
})

test("the main agent's reaction is judged, and checks resume once it is", async ($, on) => {
  const { forks, findings } = world(on)
  const judged: string[] = []
  on("session.messages", () => ({
    value: [
      { role: "user", text: `Here is a note offered by a side agent (Just So You Know).\n\n> Heads up · ${LINE}`, toolUses: [] },
      { role: "assistant", text: "Good catch. I'll add the locale to the cache key before finishing.", toolUses: [] },
    ],
  }))
  on("model.complete", (_$, e) => {
    judged.push(e.prompt)
    return { value: { isAnswered: true, text: "verdict: helped\nevidence: It added the locale to the cache key.", usage: USAGE } }
  })
  await $.session.start({ cwd: "/work/shop", surface: "terminal", isInteractive: true })

  await step($, "t1", 6)
  await eventually($, () => findings().length === 1)
  await $.turn.complete({ answer: "done", durationMs: 1, isAborted: false, turnId: "t1", reason: "answer" })
  await eventually($, () => findings()[0]?.verdict !== undefined)

  expect(judged.length).toBe(1)
  expect(findings()).toEqual([
    expect.objectContaining({ line: LINE, verdict: "helped", evidence: "It added the locale to the cache key." }),
  ])

  await step($, "t2", 6)
  await eventually($, () => forks.length === 2)
})

test("the reaction is judged even when the session's messages leave out the hidden note", async ($, on) => {
  const { findings } = world(on)
  const earlier: SessionMessage[] = [
    { role: "user", text: "Fix the page cache for the shop.", toolUses: [] },
    { role: "assistant", text: "Working on it.", toolUses: [] },
  ]
  const conversation = [...earlier]
  on("session.messages", () => ({ value: [...conversation] }))
  on("model.complete", () => ({
    value: { isAnswered: true, text: "verdict: helped\nevidence: It kept the listing off main.", usage: USAGE },
  }))
  await $.session.start({ cwd: "/work/shop", surface: "terminal", isInteractive: true })

  await step($, "t1", 6)
  await eventually($, () => findings().length === 1)
  conversation.push({ role: "assistant", text: "Good point, I'll keep the listing on a branch.", toolUses: [] })
  await $.turn.complete({ answer: "done", durationMs: 1, isAborted: false, turnId: "t1", reason: "answer" })
  await eventually($, () => findings()[0]?.verdict !== undefined)

  expect(findings()).toEqual([expect.objectContaining({ verdict: "helped", evidence: "It kept the listing off main." })])
})

test("a note still waiting after two of the person's prompts counts as no reaction", async ($, on) => {
  const { findings } = world(on)
  on("prompt.submit", (_$, e) => ({ text: e.text }))
  await $.session.start({ cwd: "/work/shop", surface: "terminal", isInteractive: true })

  await step($, "t1", 6)
  await eventually($, () => findings().length === 1)
  await $.prompt.submit({ text: "keep going", origin: { kind: "composer" }, turnId: "t2", wait: false })
  expect(findings()[0]?.verdict).toBeUndefined()
  await $.prompt.submit({ text: "and the tests", origin: { kind: "composer" }, turnId: "t3", wait: false })

  expect(findings()).toEqual([expect.objectContaining({ verdict: "ignored" })])
})

test("a note the side agent already shared is not shared again", async ($, on) => {
  const { forks, toasts, findings } = world(on, { seen: [LINE] })
  await $.session.start({ cwd: "/work/shop", surface: "terminal", isInteractive: true })

  await step($, "t1", 6)
  await eventually($, () => forks.length === 1)
  await new Promise(resolve => setTimeout(resolve, 50))

  expect(findings()).toEqual([])
  expect(toasts).toEqual([])
})

for (const surface of ["terminal", "desktop"] as const)
  test(`the pane lists this session's notes and how they landed (${surface})`, async ($, on) => {
    world(on, {
      findings: [
        { id: "a", sessionId: "s1", project: "shop", turnId: "t1", step: 6, sharedAt: 1, tag: "Heads up", line: LINE, promptsSurvived: 0, verdict: "already_aware", evidence: "It said the locale was already handled." },
        { id: "b", sessionId: "other", project: "blog", turnId: "t9", step: 6, sharedAt: 2, tag: "You should know", line: "Another session's note.", promptsSurvived: 0 },
      ],
    })

    const ui = await $.ui.mount({
      plugin: "just-so-you-know",
      surface,
      component: "Pane",
      requestId: "just-so-you-know",
      props: { title: "Just So You Know", isFocused: false, bodyColumns: 80, placement: "dock", scroll: { offset: 0, bodyRows: 30 }, view: {} },
    })

    expect((await ui.find({ type: "Text", text: LINE }))?.text).toContain("Heads up")
    expect((await ui.find({ type: "Text", text: /already aware/ }))?.text).toContain("It said the locale was already handled.")
    expect(await ui.find({ type: "Text", text: "Another session's note." })).toBeUndefined()
    await ui.unmount()
  })

for (const surface of ["terminal", "desktop"] as const)
  test(`the pane's own Close button closes it (${surface})`, async ($, on) => {
    world(on)
    const closed: string[] = []
    on("ui.close", (_$, e) => {
      closed.push(e.id)
      return { value: undefined }
    })

    const ui = await $.ui.mount({
      plugin: "just-so-you-know",
      surface,
      component: "Pane",
      requestId: "just-so-you-know",
      props: { title: "Just So You Know", isFocused: false, bodyColumns: 80, placement: "dock", scroll: { offset: 0, bodyRows: 30 }, view: {} },
    })
    await ui.press({ key: "close" })

    expect(closed).toEqual(["just-so-you-know"])
    await ui.unmount()
  })
