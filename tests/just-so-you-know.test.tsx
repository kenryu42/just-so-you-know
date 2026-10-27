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

const AGENTS = "/Users/someone/.claude/just-so-you-know/agents"
const BUILT_IN = "is there something the person behind this session really needs to understand"
const EVIDENCE_LINE = "The commit says the tests pass, but the session never ran them."
const EVIDENCE_REPLY = `learn: ${EVIDENCE_LINE}\ntag: Heads up`
const NONE = "learn: none"

type World = { entries?: Record<string, unknown>; files?: Record<string, string>; reply?: (prompt: string) => string }

function world(on: On, { entries = {}, files = {}, reply = () => SIDE_AGENT_REPLY }: World = {}) {
  const store = new Map(Object.entries(entries))
  const disk = new Map(Object.entries(files))
  mock.env(on, { HOME: "/Users/someone" })
  on("fs.write", (_$, e) => {
    disk.set(e.path, e.text)
    return { value: undefined }
  })
  on("fs.read", (_$, e) => {
    const text = disk.get(e.path)
    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text }
  })
  on("fs.list", (_$, e) => {
    const names = [...disk.keys()].filter(path => path.startsWith(`${e.path}/`)).map(path => path.slice(e.path.length + 1))
    if (names.length === 0) return { deny: `ENOENT: ${e.path}` }
    return { value: names.map(name => ({ name, kind: "file" as const, size: 0, mtimeMs: 1, isLink: false })) }
  })
  on("store.get", (_$, e) => ({ value: store.get(e.key) }))
  on("store.set", (_$, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  const session = mock.session(on)
  const forks: string[] = []
  const toasts: string[] = []
  const logged: string[] = []
  on("session.start", (_$, e) => ({ cwd: e.cwd }))
  on("session.id", () => ({ value: "s1" }))
  on("session.surfaces", () => ({ value: ["terminal"] }))
  on("command.register", () => ({ value: { command: "jsyk" } }))
  on("ui.toast", (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on("ui.log", (_$, e) => {
    if (e.to === "transcript") logged.push(e.text)
    return { value: undefined }
  })
  const opened: string[] = []
  const closed: string[] = []
  const submitted: string[] = []
  const copied: string[] = []
  on("ui.open", (_$, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on("ui.close", (_$, e) => {
    closed.push(e.id)
    return { value: undefined }
  })
  on("ui.panes", () => ({
    value: opened.filter(id => !closed.includes(id)).map(id => ({ id, title: id, isShown: true, isFocused: true, isPlaced: true })),
  }))
  on("ui.copy", (_$, e) => {
    copied.push(e.text)
    return { value: { isCopied: true } }
  })
  on("prompt.submit", (_$, e) => {
    if (e.origin.kind === "plugin") submitted.push(e.text)
    return { text: e.text }
  })
  on("model.fork", (_$, e) => {
    forks.push(e.prompt)
    return { value: { isAnswered: true, text: reply(e.prompt), usage: USAGE } }
  })
  on("turn.step", async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: "", toolUses: [], stopReason: "end_turn" as const, usage: null }
  })
  on("turn.complete", (_$, e) => ({ text: e.answer }))
  const findings = () => {
    const stored = store.get("findings")
    return Array.isArray(stored) ? (stored as { line: string; agent?: string; verdict?: string; evidence?: string }[]) : []
  }
  return { session, forks, toasts, logged, findings, disk, opened, closed, submitted, copied }
}

const PANE = {
  plugin: "just-so-you-know",
  surface: "terminal",
  component: "Pane",
  requestId: "just-so-you-know",
  props: { title: "Just So You Know", isFocused: true, bodyColumns: 80, placement: "dock", scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const
const CONFIG = "/Users/someone/.claude/just-so-you-know/config.json"
const EVIDENCE_FILE = { [`${AGENTS}/evidence.md`]: "## Your job\nEVIDENCE: find claims nothing in the session backs up." }
const config = (disk: Map<string, string>) => JSON.parse(disk.get(CONFIG) ?? "{}")

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
  const { session, forks, toasts, logged, findings } = world(on)
  await $.session.start({ cwd: "/work/shop", surface: "terminal", isInteractive: true })

  await step($, "t1", 5)
  await settle()
  expect(forks.length).toBe(0)

  await step($, "t1", 6)
  await eventually($, () => findings().length === 1)

  expect(forks.length).toBe(1)
  expect(forks[0]).toContain(BUILT_IN)
  const rows = session.appended().map(row => JSON.stringify(row.message.content))
  expect(rows.some(row => row.includes("Here is a note offered by a side agent (Just So You Know)"))).toBe(true)
  expect(rows.some(row => row.includes(`Heads up · ${LINE}`))).toBe(true)
  // A system row a plugin appends is an "info" notice, which the condensed view folds away mid-turn.
  expect(session.appended().filter(row => row.message.type === "system")).toEqual([])
  expect(logged).toEqual([`Just So You Know told the main agent: Heads up · ${LINE} (from understanding)`])
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
  await $.session.start({ cwd: "/work/shop", surface: "terminal", isInteractive: true })

  await step($, "t1", 6)
  await eventually($, () => findings().length === 1)
  await $.prompt.submit({ text: "keep going", origin: { kind: "composer" }, turnId: "t2", wait: false })
  expect(findings()[0]?.verdict).toBeUndefined()
  await $.prompt.submit({ text: "and the tests", origin: { kind: "composer" }, turnId: "t3", wait: false })

  expect(findings()).toEqual([expect.objectContaining({ verdict: "ignored" })])
})

test("a note the side agent already shared is not shared again", async ($, on) => {
  const { forks, toasts, findings } = world(on, { entries: { seen: [LINE] } })
  await $.session.start({ cwd: "/work/shop", surface: "terminal", isInteractive: true })

  await step($, "t1", 6)
  await eventually($, () => forks.length === 1)
  await new Promise(resolve => setTimeout(resolve, 50))

  expect(findings()).toEqual([])
  expect(toasts).toEqual([])
})

test("each side agent in the folder checks too, and what they find reaches the main agent in one message", async ($, on) => {
  const { session, forks, toasts, findings } = world(on, {
    files: { [`${AGENTS}/evidence.md`]: "## Your job\nEVIDENCE: find claims nothing in the session backs up." },
    reply: prompt => (prompt.includes("EVIDENCE:") ? EVIDENCE_REPLY : SIDE_AGENT_REPLY),
  })
  await $.session.start({ cwd: "/work/shop", surface: "terminal", isInteractive: true })

  await step($, "t1", 6)
  await eventually($, () => findings().length === 2)

  expect(forks.length).toBe(2)
  expect(findings()).toEqual([
    expect.objectContaining({ agent: "understanding", line: LINE }),
    expect.objectContaining({ agent: "evidence", line: EVIDENCE_LINE }),
  ])
  const notes = session.appended().filter(row => row.message.type === "user")
  expect(notes.length).toBe(1)
  const note = JSON.stringify(notes[0]?.message.content)
  expect(note).toContain(`Heads up · ${LINE}`)
  expect(note).toContain(`Heads up · ${EVIDENCE_LINE}`)
  expect(toasts).toEqual(["Just So You Know told the main agent 2 notes. Run /jsyk to see them."])
})

test("a file named understanding.md replaces the built-in side agent", async ($, on) => {
  const { forks, findings } = world(on, {
    files: { [`${AGENTS}/understanding.md`]: "## Your job\nMY OWN TAKE on what the person misses." },
  })
  await $.session.start({ cwd: "/work/shop", surface: "terminal", isInteractive: true })

  await step($, "t1", 6)
  await eventually($, () => findings().length === 1)

  expect(forks.length).toBe(1)
  expect(forks[0]).toContain("MY OWN TAKE")
  expect(forks[0]).not.toContain(BUILT_IN)
})

test("a note waiting on one side agent does not hold back the others", async ($, on) => {
  const { forks, findings } = world(on, {
    files: { [`${AGENTS}/evidence.md`]: "## Your job\nEVIDENCE: find claims nothing in the session backs up." },
    reply: prompt => (prompt.includes("EVIDENCE:") ? NONE : SIDE_AGENT_REPLY),
  })
  await $.session.start({ cwd: "/work/shop", surface: "terminal", isInteractive: true })

  await step($, "t1", 6)
  await eventually($, () => findings().length === 1)
  expect(forks.length).toBe(2)

  await step($, "t2", 6)
  await eventually($, () => forks.length === 3)
  await settle()

  expect(forks.length).toBe(3)
  expect(forks[2]).toContain("EVIDENCE:")
})

test("two side agents raising the same thing at once share it once", async ($, on) => {
  const { session, forks, findings } = world(on, {
    files: { [`${AGENTS}/evidence.md`]: "## Your job\nEVIDENCE: find claims nothing in the session backs up." },
  })
  await $.session.start({ cwd: "/work/shop", surface: "terminal", isInteractive: true })

  await step($, "t1", 6)
  await eventually($, () => findings().length === 1)
  await settle()

  expect(forks.length).toBe(2)
  expect(findings()).toEqual([expect.objectContaining({ agent: "understanding", line: LINE })])
  const note = JSON.stringify(session.appended().find(row => row.message.type === "user")?.message.content)
  expect(note.split(LINE).length).toBe(2)
})

test("/jsyk opens the panel, which lists every side agent with its notes and whether it is on", async ($, on) => {
  const { opened } = world(on, {
    files: { ...EVIDENCE_FILE, [CONFIG]: JSON.stringify({ disabled: ["evidence"] }) },
    entries: {
      findings: [
        { id: "a", sessionId: "s1", project: "shop", turnId: "t1", step: 6, sharedAt: 1, agent: "understanding", tag: "Heads up", line: LINE, promptsSurvived: 0, verdict: "helped", evidence: "It added the locale." },
        { id: "b", sessionId: "s1", project: "shop", turnId: "t2", step: 6, sharedAt: 2, agent: "understanding", tag: "Heads up", line: "Another note.", promptsSurvived: 0, verdict: "ignored", evidence: "" },
      ],
    },
  })

  const ran = await $.command.run({ command: "jsyk", args: "", origin: { kind: "composer" }, presentation: { isFullscreen: false, columns: 120 } })
  expect(opened).toEqual(["just-so-you-know"])
  expect(ran.text ?? "").not.toContain("report.html")

  const ui = await $.ui.mount(PANE)
  const understanding = (await ui.find({ type: "Button", key: "agent:understanding" }))?.text ?? ""
  expect(understanding).toMatch(/on/)
  expect(understanding).toContain("built-in")
  expect(understanding).toContain("2 notes")
  expect(understanding).toContain("1 helped")
  const evidence = (await ui.find({ type: "Button", key: "agent:evidence" }))?.text ?? ""
  expect(evidence).toMatch(/off/)
  expect(evidence).toContain("0 notes")
  await ui.unmount()
})

test("turning a side agent off in the panel stops its checks, and turning it on brings them back", async ($, on) => {
  const { forks, disk } = world(on, { files: EVIDENCE_FILE, reply: () => NONE })
  await $.session.start({ cwd: "/work/shop", surface: "terminal", isInteractive: true })
  const ui = await $.ui.mount(PANE)

  await ui.press({ key: "agent:understanding" })
  expect(config(disk).disabled).toEqual(["understanding"])
  expect((await ui.find({ type: "Button", key: "agent:understanding" }))?.text).toMatch(/off/)

  await step($, "t1", 6)
  await eventually($, () => forks.length === 1)
  await settle()
  expect(forks.length).toBe(1)
  expect(forks[0]).toContain("EVIDENCE:")

  await ui.press({ key: "agent:understanding" })
  expect(config(disk).disabled).toEqual([])
  await step($, "t2", 6)
  await eventually($, () => forks.length === 3)
  expect(forks.slice(1).some(prompt => prompt.includes(BUILT_IN))).toBe(true)
  await ui.unmount()
})

test("the check interval set in the panel decides which steps check, and a bad value is refused", async ($, on) => {
  const { forks, disk } = world(on, { reply: () => NONE })
  await $.session.start({ cwd: "/work/shop", surface: "terminal", isInteractive: true })
  const ui = await $.ui.mount(PANE)

  await ui.input({ key: "every", text: "3" })
  expect(config(disk).checkEvery).toBe(3)

  await step($, "t1", 3)
  await eventually($, () => forks.length === 1)

  await ui.input({ key: "every", text: "0" })
  expect(config(disk).checkEvery).toBe(3)
  expect(await ui.find({ type: "Text", text: /whole number/ })).toBeDefined()
  await ui.unmount()
})

test("checks run every 6 steps when the config file is broken", async ($, on) => {
  const { forks } = world(on, { files: { [CONFIG]: "{ not json" }, reply: () => NONE })
  await $.session.start({ cwd: "/work/shop", surface: "terminal", isInteractive: true })

  await step($, "t1", 3)
  await settle()
  expect(forks.length).toBe(0)
  await step($, "t1", 6)
  await eventually($, () => forks.length === 1)
})

test("creating a side agent from the panel hands the job to the main agent with the skill", async ($, on) => {
  const { submitted, closed } = world(on)
  const ui = await $.ui.mount(PANE)

  await ui.input({ key: "create", text: "claims about tests that were never run" })

  expect(submitted).toEqual([expect.stringContaining("just-so-you-know:create-side-agent")])
  expect(submitted[0]).toContain("claims about tests that were never run")
  expect(closed).toEqual(["just-so-you-know"])
  await ui.unmount()
})

test("the panel's report button writes one page with every session's notes and opens it", async ($, on) => {
  const { disk, toasts } = world(on, {
    entries: {
      findings: [
        { id: "a", sessionId: "s1", project: "shop", turnId: "t1", step: 6, sharedAt: 1, agent: "understanding", tag: "Heads up", line: LINE, promptsSurvived: 0, verdict: "helped", evidence: "It added the locale." },
        { id: "b", sessionId: "s2", project: "blog", turnId: "t9", step: 6, sharedAt: 2, agent: "evidence", tag: "You should know", line: "Another session's note.", promptsSurvived: 0 },
      ],
    },
  })
  const launched: string[][] = []
  on("process.run", (_$, e) => {
    launched.push([...e.argv])
    return e.argv[0] === "open" ? { deny: "open: command not found" } : { value: { exitCode: 0, stdout: "", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const ui = await $.ui.mount(PANE)

  await ui.press({ key: "report" })

  const path = "/Users/someone/.claude/just-so-you-know/report.html"
  const page = disk.get(path) ?? ""
  expect(page).toContain(LINE)
  expect(page).toContain("Another session's note.")
  expect(page).toMatch(/<span class="agent">evidence<\/span>/)
  expect(launched).toEqual([["open", path], ["xdg-open", path]])
  expect(toasts).toEqual([`Opened the report: file://${path}`])
  await ui.unmount()
})

test("on the phone, where the panel draws no fields, it still lists the side agents and the interval", async ($, on) => {
  world(on)
  const ui = await $.ui.mount({ ...PANE, surface: "mobile" })

  expect((await ui.find({ type: "Button", key: "agent:understanding" }))?.text).toMatch(/on/)
  expect((await ui.find({ type: "Text", text: /every 6 steps/ }))?.text).toBeDefined()
  await ui.unmount()
})

test("the panel copies the agents folder's path", async ($, on) => {
  const { copied } = world(on)
  const ui = await $.ui.mount(PANE)

  await ui.press({ key: "copy" })

  expect(copied).toEqual([AGENTS])
  await ui.unmount()
})

test("a side agent file added while the panel is open shows up without reopening it", async ($, on) => {
  const { disk } = world(on)
  const clock = mock.clock(on)
  await $.command.run({ command: "jsyk", args: "", origin: { kind: "composer" }, presentation: { isFullscreen: false, columns: 120 } })
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: "Button", key: "agent:evidence" })).toBeUndefined()

  disk.set(`${AGENTS}/evidence.md`, EVIDENCE_FILE[`${AGENTS}/evidence.md`])
  await clock.advance(3000)

  expect((await ui.find({ type: "Button", key: "agent:evidence" }))?.text).toMatch(/on/)
  await ui.unmount()
})
