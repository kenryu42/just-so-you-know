import type { EngineInterface, Register, SessionMessage } from "claude-code"

import { findingsOf, isOpen, VERDICTS, type Finding, type Verdict } from "./finding"
import { lineKey, parseProposed } from "./parse"
import { proposePrompt } from "./prompt"
import { reportHtml } from "./report"

const CHECK_EVERY = 6
const CLEAR_AFTER_PROMPTS = 2
const SEEN_MAX = 50
const FINDINGS_MAX = 200
const LOOKS_TO_SKIP_MAX = 16
const PASSED_OVER_FREE = 2
const TITLE = "Just So You Know"
const JUDGE_MODEL = "haiku"

const looksToSkipAfter = (passedOver: number) =>
  passedOver <= PASSED_OVER_FREE ? 0 : Math.min(LOOKS_TO_SKIP_MAX, 2 ** (passedOver - PASSED_OVER_FREE - 1))
const stringsOf = (value: unknown) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
const countOf = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0

const noteFor = (finding: Finding) => {
  const quoted = [`${finding.tag} · ${finding.line}`, ...(finding.explanation ? ["", finding.explanation] : [])]
    .join("\n")
    .split("\n")
    .map(row => (row === "" ? ">" : `> ${row}`))
    .join("\n")
  return `Here is a note offered by a side agent (Just So You Know). It was shared with you automatically; the user has not reviewed it:\n\n${quoted}`
}

const judgePrompt = (finding: Finding, after: readonly SessionMessage[]) => {
  const transcript = after
    .slice(0, 16)
    .flatMap(message =>
      message.role === "assistant"
        ? [
            ...(message.text ? [`Agent: ${message.text}`] : []),
            ...message.toolUses.map(use => `Agent ran ${use.tool}: ${JSON.stringify(use.input).slice(0, 240)}`),
          ]
        : message.text && !message.toolResults?.length
          ? [`User: ${message.text}`]
          : [],
    )
    .join("\n")
    .slice(0, 8000)
  return `A side agent passed this note to a coding agent while it worked:

${finding.tag} · ${finding.line}

Here is what the coding agent said and did right after reading it:

${transcript}

How did the coding agent take the note? Pick exactly one:
- helped: it changed what it did or planned because of the note
- acknowledged: it took the note in but changed nothing, and had not already handled it
- already_aware: it says or shows it had already known or handled this
- ignored: nothing shows it read the note

Answer in exactly two lines:
verdict: <helped|acknowledged|already_aware|ignored>
evidence: <at most 25 words quoting or describing what the agent said or did>`
}

const parseJudgement = (text: string) => {
  const verdict = /verdict:\s*([a-z_]+)/i.exec(text)?.[1]?.toLowerCase()
  const evidence = /evidence:\s*(.+)/i.exec(text)?.[1]?.trim() ?? ""
  return VERDICTS.find(known => known === verdict) === undefined
    ? undefined
    : { verdict: verdict as Verdict, evidence }
}

const checking = new Set<string>()
const judging = new Set<string>()
const ended = new Set<string>()
const sharedTurns = new Map<string, string>()
const projects = new Map<string, string>()

const BROWSER_OPENERS = [["open"], ["xdg-open"], ["cmd", "/c", "start", ""]]

async function openInBrowser($: EngineInterface, path: string) {
  for (const opener of BROWSER_OPENERS) {
    const ran = await $.process.run([...opener, path], { timeoutMs: 10000 }).catch(() => undefined)
    if (ran?.exitCode === 0) return true
  }
  return false
}

async function updateFindings($: EngineInterface, change: (findings: Finding[]) => Finding[]) {
  await $.store.set("findings", change(findingsOf(await $.store.get("findings"))).slice(-FINDINGS_MAX))
}

async function settle($: EngineInterface, id: string, verdict: Verdict, evidence: string) {
  await updateFindings($, findings =>
    findings.map(finding => (finding.id === id ? { ...finding, verdict, evidence, judgedAt: Date.now() } : finding)),
  )
  const isPassedOver = verdict === "ignored" || verdict === "already_aware"
  const passedOver = isPassedOver ? countOf(await $.store.get("passedOverInARow")) + 1 : 0
  await $.store.set("passedOverInARow", passedOver)
  await $.store.set("looksToSkip", looksToSkipAfter(passedOver))
  if (verdict !== "already_aware") return
  const finding = findingsOf(await $.store.get("findings")).find(one => one.id === id)
  const known = stringsOf(await $.store.get("known"))
  if (finding && !known.some(line => lineKey(line) === lineKey(finding.line)))
    await $.store.set("known", [...known, finding.line].slice(-SEEN_MAX))
}

async function check($: EngineInterface, sessionId: string, turnId: string, step: number) {
  const seen = stringsOf(await $.store.get("seen"))
  const known = stringsOf(await $.store.get("known"))
  const reply = await $.model.fork({ prompt: proposePrompt(seen, known) })
  if (!reply.isAnswered) return
  const proposed = parseProposed(reply.text)
  if (proposed.kind !== "line") return
  if ([...seen, ...known].some(line => lineKey(line) === lineKey(proposed.line))) return
  if (ended.has(sessionId)) return
  await $.store.set("seen", [...seen, proposed.line].slice(-SEEN_MAX))
  const finding: Finding = {
    id: `${sessionId}:${turnId}:${step}`,
    sessionId,
    project: projects.get(sessionId) ?? "",
    turnId,
    step,
    sharedAt: Date.now(),
    tag: proposed.tag,
    line: proposed.line,
    explanation: proposed.explanation,
    promptsSurvived: 0,
  }
  const messageCount = await $.session
    .messages()
    .then(messages => messages.length)
    .catch(() => undefined)
  const delivered = await $.session
    .append({ message: { type: "user", content: [{ type: "text", text: noteFor(finding) }] } })
    .then(result => ("deny" in result && result.deny ? result.deny : undefined))
    .catch((error: unknown) => (error instanceof Error ? error.message : String(error)))
  sharedTurns.set(sessionId, turnId)
  await updateFindings($, findings => [...findings, { ...finding, messageCount, deliveryError: delivered }])
  if (delivered === undefined)
    await $.session
      .append({ message: { type: "system", content: [{ type: "text", text: `${TITLE} told the main agent: ${finding.tag} · ${finding.line}` }] } })
      .catch(() => undefined)
  $.ui.toast(delivered === undefined ? `${TITLE} told the main agent: ${proposed.line}` : `${TITLE} could not share a note: ${delivered}`)
}

async function judge($: EngineInterface, sessionId: string) {
  if (judging.has(sessionId)) return
  judging.add(sessionId)
  try {
    const open = findingsOf(await $.store.get("findings")).filter(
      finding => finding.sessionId === sessionId && isOpen(finding),
    )
    if (open.length === 0) return
    const messages = await $.session.messages()
    for (const finding of open) {
      const at = messages.findLastIndex(message => message.role === "user" && message.text.includes(finding.line))
      const start = at === -1 ? finding.messageCount : at + 1
      const after = start === undefined ? [] : messages.slice(start)
      if (!after.some(message => message.role === "assistant")) continue
      const answer = await $.model.complete({
        model: JUDGE_MODEL,
        prompt: judgePrompt(finding, after),
        effort: "low",
        maxTokens: 200,
        timeoutMs: 60000,
      })
      const judgement = answer.isAnswered ? parseJudgement(answer.text) : undefined
      if (judgement) await settle($, finding.id, judgement.verdict, judgement.evidence)
    }
  } finally {
    judging.delete(sessionId)
  }
}

export const register: Register = on => {
  on("session.start", async ($, e, next) => {
    projects.set(await $.session.id(), e.cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? "")
    await $.command.register({
      name: "jsyk",
      description: "Just So You Know: write the report of every session's notes as a page and open it",
    })
    return next(e)
  })

  on("session.end", async (_$, e, next) => {
    ended.add(e.sessionId)
    return next(e)
  })

  on("prompt.submit", async ($, e, next) => {
    if (e.origin.kind !== "composer" && e.origin.kind !== "bridge") return next(e)
    const sessionId = await $.session.id()
    const open = findingsOf(await $.store.get("findings")).filter(
      finding => finding.sessionId === sessionId && isOpen(finding),
    )
    const survived = open.map(finding => ({ ...finding, promptsSurvived: finding.promptsSurvived + 1 }))
    await updateFindings($, findings =>
      findings.map(finding => survived.find(one => one.id === finding.id) ?? finding),
    )
    for (const finding of survived.filter(one => one.promptsSurvived >= CLEAR_AFTER_PROMPTS))
      await settle($, finding.id, "ignored", `No reaction after ${CLEAR_AFTER_PROMPTS} of your prompts.`)
    return next(e)
  }).catch(($, e, next) => next(e))

  on("turn.step", async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)
    const isDue = e.index > 0 && e.index % CHECK_EVERY === 0
    if (isDue)
      void (async () => {
        const sessionId = await $.session.id()
        if ((await $.session.surfaces()).length === 0) return
        if (sharedTurns.get(sessionId) === e.turnId || checking.has(sessionId)) return
        const hasOpen = findingsOf(await $.store.get("findings")).some(
          finding => finding.sessionId === sessionId && isOpen(finding),
        )
        if (hasOpen) return
        const looksToSkip = Math.min(LOOKS_TO_SKIP_MAX, countOf(await $.store.get("looksToSkip")))
        if (looksToSkip > 0) return $.store.set("looksToSkip", looksToSkip - 1)
        checking.add(sessionId)
        await check($, sessionId, e.turnId, e.index).finally(() => checking.delete(sessionId))
      })().catch(() => undefined)
    return yield* next(e)
  })

  on("turn.complete", async ($, e, next) => {
    if (e.agentId === undefined) void $.session.id().then(sessionId => judge($, sessionId)).catch(() => undefined)
    return next(e)
  })

  on("command.run", { command: "jsyk" }, async $ => {
    const home = await $.env.get("HOME")
    if (!home) return { text: "Could not find your home folder to write the report." }
    const path = `${home}/.claude/just-so-you-know/report.html`
    await $.fs.write(path, reportHtml(findingsOf(await $.store.get("findings")), Date.now()))
    const isOpened = await openInBrowser($, path)
    return { text: `Wrote the report of every session's notes: file://${path}${isOpened ? " (Opened it in your browser.)" : ""}` }
  })
}
