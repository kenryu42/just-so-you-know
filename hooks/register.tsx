import type { EngineInterface, Register, SessionMessage, Timer } from "claude-code"

import { findingsOf, isOpen, VERDICTS, type Finding, type Verdict } from "./finding"
import { lineKey, parseProposed } from "./parse"
import { proposePrompt, UNDERSTANDING } from "./prompt"
import { reportHtml } from "./report"

const CHECK_EVERY = 6
const CHECK_EVERY_MAX = 100
const CLEAR_AFTER_PROMPTS = 2
const SEEN_MAX = 50
const FINDINGS_MAX = 200
const LOOKS_TO_SKIP_MAX = 16
const PASSED_OVER_FREE = 2
const TITLE = "Just So You Know"
const JUDGE_MODEL = "haiku"
const JUDGE_CHARS_MAX = 16000
const AGENT_TEXT_MAX = 4000
const OTHER_LINE_MAX = 200
const DATA_DIR = ".claude/just-so-you-know"
const REPOS_DIR = "projects"
const BUILT_IN = "understanding"
const PANE = "just-so-you-know"
const AGENTS_POLL_MS = 2000

const looksToSkipAfter = (passedOver: number) =>
  passedOver <= PASSED_OVER_FREE ? 0 : Math.min(LOOKS_TO_SKIP_MAX, 2 ** (passedOver - PASSED_OVER_FREE - 1))
const stringsOf = (value: unknown) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
const countOf = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0

const titleOf = (name: string) =>
  name
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(word => word[0]!.toUpperCase() + word.slice(1))
    .join(" ")

const quoted = (finding: Finding) =>
  [`${finding.tag} · ${finding.line}`, ...(finding.explanation ? ["", finding.explanation] : [])]
    .join("\n")
    .split("\n")
    .map(row => (row === "" ? ">" : `> ${row}`))
    .join("\n")

const noteFor = (findings: readonly Finding[]) =>
  findings.length === 1
    ? `Here is a note offered by a side agent (Just So You Know). It was shared with you automatically; the user has not reviewed it:\n\n${quoted(findings[0]!)}`
    : `Here are ${findings.length} notes offered by side agents (Just So You Know). They were shared with you automatically; the user has not reviewed them:\n\n${findings.map(quoted).join("\n\n")}`

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text)

// The agent's own words are what show a reaction, so they are kept whole; the rest is shortened and dropped first.
const judgePrompt = (finding: Finding, after: readonly SessionMessage[]) => {
  const lines = after.flatMap(message =>
    message.role === "assistant"
      ? [
          ...(message.text ? [{ isAgentText: true, text: `Agent: ${clip(message.text, AGENT_TEXT_MAX)}` }] : []),
          ...message.toolUses.map(use => ({ isAgentText: false, text: `Agent ran ${use.tool}: ${clip(JSON.stringify(use.input), OTHER_LINE_MAX)}` })),
        ]
      : message.text && !message.toolResults?.length
        ? [{ isAgentText: false, text: `Message to the agent: ${clip(message.text, OTHER_LINE_MAX)}` }]
        : [],
  )
  let room = lines.reduce((left, line) => (line.isAgentText ? left - line.text.length : left), JUDGE_CHARS_MAX)
  const transcript = lines
    .filter(line => line.isAgentText || (room -= line.text.length) >= 0)
    .map(line => line.text)
    .join("\n")
    .slice(0, JUDGE_CHARS_MAX)
  return `A side agent passed this note to a coding agent while it worked:

${finding.tag} · ${finding.line}${finding.explanation ? `\n\n${finding.explanation}` : ""}

Here is what came after the note: what the coding agent said, the tools it ran, and messages it received (from the user or the system), shortened:

${transcript}

How did the coding agent take the note? It may act on a note without mentioning it, so compare what it said and did with the note's point. Pick exactly one:
- helped: what it did, said or planned changed in line with the note's point, whether or not it mentions the note
- acknowledged: it took the note's point in but changed nothing, and had not already handled it
- already_aware: it says or shows it had already known or handled this before the note
- ignored: nothing it said or did after the note reflects the note's point

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

let panelError: string | undefined
// No file events reach a mod, so the open panel polls the agents folder and redraws when it changes.
let agentsWatch: Timer | undefined
let agentsDrawn = ""

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

// A user side agent runs in every repo, a project one in one repo; its on/off has the same reach.
type SideAgent = { name: string; job: string; scope: "user" | "project"; isBuiltIn: boolean }
type Config = { checkEvery: number; disabled: string[]; disabledIn: Record<string, string[]> }

const dataDir = async ($: EngineInterface) => {
  const home = await $.env.get("HOME")
  return home ? `${home}/${DATA_DIR}` : undefined
}

async function readConfig($: EngineInterface): Promise<Config> {
  const dir = await dataDir($)
  const raw = dir ? await $.fs.read(`${dir}/config.json`).catch(() => "") : ""
  let parsed: { checkEvery?: unknown; disabled?: unknown; disabledIn?: unknown } = {}
  try {
    const value: unknown = raw ? JSON.parse(raw) : {}
    if (typeof value === "object" && value !== null) parsed = value
  } catch {}
  const every = parsed.checkEvery
  return {
    checkEvery: Number.isSafeInteger(every) && (every as number) >= 1 && (every as number) <= CHECK_EVERY_MAX ? (every as number) : CHECK_EVERY,
    disabled: stringsOf(parsed.disabled),
    disabledIn:
      typeof parsed.disabledIn === "object" && parsed.disabledIn !== null
        ? Object.fromEntries(Object.entries(parsed.disabledIn).map(([repo, names]) => [repo, stringsOf(names)]))
        : {},
  }
}

const isOff = (config: Config, repo: string, agent: SideAgent) =>
  (agent.scope === "user" ? config.disabled : (config.disabledIn[repo] ?? [])).includes(agent.name)

const flipped = (names: readonly string[], name: string) =>
  names.includes(name) ? names.filter(one => one !== name) : [...names, name]

async function writeConfig($: EngineInterface, change: (config: Config) => Config) {
  const dir = await dataDir($)
  if (!dir) throw new Error("Could not find your home folder.")
  await $.fs.write(`${dir}/config.json`, `${JSON.stringify(change(await readConfig($)), null, 2)}\n`)
}

const repoRoots = new Map<string, Promise<string>>()

// Keyed by the repo, not the folder: every worktree and subfolder of a repo shares its git common dir.
const repoRoot = async ($: EngineInterface) => {
  const root = await $.session.root()
  const known = repoRoots.get(root)
  if (known) return known
  const found = $.process
    .run(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: root, timeoutMs: 10000 })
    .then(ran => {
      const common = ran.exitCode === 0 ? ran.stdout.trim() : ""
      return /[\\/]\.git$/.test(common) ? common.slice(0, -5) : root
    })
    .catch(() => root)
  repoRoots.set(root, found)
  return found
}

const repoKey = async ($: EngineInterface) => (await repoRoot($)).replace(/[^a-zA-Z0-9]/g, "-")

// Kept in the home folder like the rest, so a repository can't add side agents of its own.
const repoAgentsDir = async ($: EngineInterface, dir: string) => `${dir}/${REPOS_DIR}/${await repoKey($)}/agents`

async function agentsIn($: EngineInterface, folder: string, scope: SideAgent["scope"]): Promise<SideAgent[]> {
  const entries = await $.fs.list(folder).catch(() => [])
  const files = entries.filter(entry => entry.name.endsWith(".md") && (entry.kind === "file" || entry.isLink)).map(entry => entry.name)
  const read = await Promise.all(
    files.map(async file => ({ name: file.slice(0, -3), job: (await $.fs.read(`${folder}/${file}`).catch(() => "")).trim(), scope, isBuiltIn: false })),
  )
  return read.filter(agent => agent.job !== "")
}

// The built-in agent lives here, not in a folder, so changes to it reach everyone; a file of the same name replaces it,
// and one in the repo's folder replaces the agents folder's.
async function allAgents($: EngineInterface): Promise<SideAgent[]> {
  const dir = await dataDir($)
  const [everywhere, repo] = dir
    ? await Promise.all([agentsIn($, `${dir}/agents`, "user"), agentsIn($, await repoAgentsDir($, dir), "project")])
    : [[], []]
  const byName = new Map([...everywhere, ...repo].map(agent => [agent.name, agent]))
  const own = [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return byName.has(BUILT_IN) ? own : [{ name: BUILT_IN, job: UNDERSTANDING, scope: "user", isBuiltIn: true }, ...own]
}

const backoffKey = (key: string, agent: string) => `${key}:${agent}`

async function settle($: EngineInterface, id: string, verdict: Verdict, evidence: string) {
  await updateFindings($, findings =>
    findings.map(finding => (finding.id === id ? { ...finding, verdict, evidence, judgedAt: Date.now() } : finding)),
  )
  const finding = findingsOf(await $.store.get("findings")).find(one => one.id === id)
  if (!finding) return
  const isPassedOver = verdict === "ignored" || verdict === "already_aware"
  const passedOver = isPassedOver ? countOf(await $.store.get(backoffKey("passedOverInARow", finding.agent))) + 1 : 0
  await $.store.set(backoffKey("passedOverInARow", finding.agent), passedOver)
  await $.store.set(backoffKey("looksToSkip", finding.agent), looksToSkipAfter(passedOver))
  if (verdict !== "already_aware") return
  const known = stringsOf(await $.store.get("known"))
  if (!known.some(line => lineKey(line) === lineKey(finding.line)))
    await $.store.set("known", [...known, finding.line].slice(-SEEN_MAX))
}

async function check($: EngineInterface, sessionId: string, turnId: string, step: number) {
  const open = findingsOf(await $.store.get("findings")).filter(
    finding => finding.sessionId === sessionId && isOpen(finding),
  )
  const config = await readConfig($)
  const repo = await repoKey($)
  const ready: SideAgent[] = []
  for (const agent of await allAgents($)) {
    if (isOff(config, repo, agent)) continue
    if (sharedTurns.get(`${sessionId}:${agent.name}`) === turnId) continue
    if (open.some(finding => finding.agent === agent.name)) continue
    const looksToSkip = Math.min(LOOKS_TO_SKIP_MAX, countOf(await $.store.get(backoffKey("looksToSkip", agent.name))))
    if (looksToSkip > 0) await $.store.set(backoffKey("looksToSkip", agent.name), looksToSkip - 1)
    else ready.push(agent)
  }
  if (ready.length === 0) return
  const seen = stringsOf(await $.store.get("seen"))
  const known = stringsOf(await $.store.get("known"))
  const replies = await Promise.all(
    ready.map(agent => $.model.fork({ prompt: proposePrompt(agent.job, seen, known) }).catch(() => undefined)),
  )
  const taken = new Set([...seen, ...known].map(lineKey))
  const shared: Finding[] = []
  ready.forEach((agent, at) => {
    const reply = replies[at]
    if (!reply?.isAnswered) return
    const proposed = parseProposed(reply.text)
    if (proposed.kind !== "line" || taken.has(lineKey(proposed.line))) return
    taken.add(lineKey(proposed.line))
    shared.push({
      id: `${sessionId}:${turnId}:${step}:${agent.name}`,
      sessionId,
      project: projects.get(sessionId) ?? "",
      turnId,
      step,
      agent: agent.name,
      sharedAt: Date.now(),
      tag: proposed.tag,
      line: proposed.line,
      explanation: proposed.explanation,
      promptsSurvived: 0,
    })
  })
  if (shared.length === 0 || ended.has(sessionId)) return
  await $.store.set("seen", [...seen, ...shared.map(finding => finding.line)].slice(-SEEN_MAX))
  const messageCount = await $.session
    .messages()
    .then(messages => messages.length)
    .catch(() => undefined)
  const delivered = await $.session
    .append({ message: { type: "user", content: [{ type: "text", text: noteFor(shared) }] } })
    .then(result => ("deny" in result && result.deny ? result.deny : undefined))
    .catch((error: unknown) => (error instanceof Error ? error.message : String(error)))
  for (const finding of shared) sharedTurns.set(`${sessionId}:${finding.agent}`, turnId)
  await updateFindings($, findings => [
    ...findings,
    ...shared.map(finding => ({ ...finding, messageCount, deliveryError: delivered })),
  ])
  // Not a system row: the engine files a plugin's as an "info" notice, which the condensed view folds away mid-turn.
  if (delivered === undefined)
    for (const finding of shared)
      $.ui.log(`[${titleOf(finding.agent)} Side Agent] ${finding.line}`)
  $.ui.toast(
    delivered !== undefined
      ? `${TITLE} could not share ${shared.length === 1 ? "a note" : "its notes"}: ${delivered}`
      : shared.length === 1
        ? `${TITLE}: ${shared[0]!.line}`
        : `${TITLE}: ${shared.length} notes`,
  )
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
      description: "Just So You Know: side agents, check interval, a new side agent, and the report",
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
    void (async () => {
      const { checkEvery } = await readConfig($)
      if (e.index > 0 && e.index % checkEvery === 0) {
        const sessionId = await $.session.id()
        if ((await $.session.surfaces()).length === 0) return
        if (checking.has(sessionId)) return
        checking.add(sessionId)
        await check($, sessionId, e.turnId, e.index).finally(() => checking.delete(sessionId))
      }
    })().catch(() => undefined)
    return yield* next(e)
  })

  on("turn.complete", async ($, e, next) => {
    if (e.agentId === undefined) void $.session.id().then(sessionId => judge($, sessionId)).catch(() => undefined)
    return next(e)
  })

  on("command.run", { command: "jsyk" }, async $ => {
    panelError = undefined
    await $.ui.open({ id: PANE, title: TITLE, focus: true, closeOnEscape: true })
    return {}
  })

  on("ui.render", { component: "Pane", requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Button, Text } = elements
    // The mobile app draws no fields yet.
    const Input = e.surface !== "mobile" && "Input" in elements ? elements.Input : undefined
    const dir = (await dataDir($)) ?? `~/${DATA_DIR}`
    const repo = await repoKey($)
    const repoName = (await repoRoot($)).split(/[\\/]/).filter(Boolean).at(-1) ?? "this repo"
    const repoDir = await repoAgentsDir($, dir)
    const config = await readConfig($)
    const agents = await allAgents($)
    const findings = findingsOf(await $.store.get("findings"))
    const redraw = () => $.ui.invalidate("ui.render")
    agentsDrawn = JSON.stringify(agents)
    agentsWatch ??= $.clock.every(AGENTS_POLL_MS, () => {
      void (async () => {
        if (!(await $.ui.panes()).some(pane => pane.id === PANE)) {
          agentsWatch?.cancel()
          agentsWatch = undefined
        } else if (JSON.stringify(await allAgents($)) !== agentsDrawn) await redraw()
      })().catch(() => undefined)
    })
    const failed = (error: unknown) => {
      panelError = error instanceof Error ? error.message : String(error)
      redraw()
    }
    const toggle = (agent: SideAgent) =>
      writeConfig($, current => {
        if (agent.scope === "user") return { ...current, disabled: flipped(current.disabled, agent.name) }
        const { [repo]: here = [], ...others } = current.disabledIn
        const next = flipped(here, agent.name)
        return { ...current, disabledIn: next.length === 0 ? others : { ...others, [repo]: next } }
      })
        .then(() => {
          panelError = undefined
          redraw()
        })
        .catch(failed)
    const setEvery = (text: string) => {
      const every = Number(text.trim())
      if (!Number.isSafeInteger(every) || every < 1 || every > CHECK_EVERY_MAX) {
        panelError = `Check every needs a whole number from 1 to ${CHECK_EVERY_MAX}.`
        return redraw()
      }
      return writeConfig($, current => ({ ...current, checkEvery: every }))
        .then(() => {
          panelError = undefined
          redraw()
        })
        .catch(failed)
    }
    const create = async (text: string) => {
      const what = text.trim()
      if (what === "") return
      await $.ui.close({ id: PANE })
      await $.prompt.submit({
        text: `Create a ${TITLE} side agent that watches for: ${what}\n\nUse the just-so-you-know:create-side-agent skill. Side agents for every repo go in ${dir}/agents, and ones for this repo only in ${repoDir}.`,
      })
    }
    const openReport = async () => {
      const path = `${dir}/report.html`
      const sessionId = await $.session.id()
      await $.fs.write(path, reportHtml(findings.filter(finding => finding.sessionId === sessionId), Date.now()))
      const isOpened = await openInBrowser($, path)
      $.ui.toast(isOpened ? `Opened the report: file://${path}` : `Wrote the report: file://${path}`)
    }
    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" justifyContent="space-between" gap={2}>
          <Text bold>Side agents</Text>
          <Button key="close" label="Close" hotkey="x" plain onPress={() => $.ui.close({ id: PANE })} />
        </Box>
        {(["user", "project"] as const).map(scope => {
          const listed = agents.filter(agent => agent.scope === scope)
          return (
            <Box key={`scope:${scope}`} flexDirection="column">
              <Text>
                <Text bold>{scope === "user" ? "User" : "Project"}</Text>{" "}
                <Text dimColor>{scope === "user" ? "every repo" : repoName}</Text>
              </Text>
              {listed.map(agent => {
                const own = findings.filter(finding => finding.agent === agent.name)
                const helped = own.filter(finding => finding.verdict === "helped").length
                return (
                  <Button key={`agent:${agent.name}`} plain onPress={() => toggle(agent)}>
                    {isOff(config, repo, agent) ? "○ off" : "● on "} {agent.name}{" "}
                    <Text dimColor>
                      {agent.isBuiltIn ? "built-in · " : ""}
                      {own.length} {own.length === 1 ? "note" : "notes"} · {helped} helped
                    </Text>
                  </Button>
                )
              })}
              {listed.length === 0 && <Text dimColor>No side agents for this repo yet. Press p to copy its folder path.</Text>}
            </Box>
          )
        })}
        <Text dimColor>Press a side agent to turn it on or off: a user one in every repo, a project one in this repo.</Text>
        {Input ? (
          <Box flexDirection="column" gap={1}>
            <Input key="every" label="Check every (steps)" value={String(config.checkEvery)} submitLabel="save" onSubmit={setEvery} />
            <Box flexDirection="row" gap={1}>
              <Button key="new" label="New side agent" hotkey="n" plain onPress={() => $.ui.focus({ requestId: PANE, key: "create" }).catch(failed)} />
              <Input key="create" placeholder="what it should watch for" submitLabel="create" onSubmit={text => create(text).catch(failed)} />
            </Box>
          </Box>
        ) : (
          <Text dimColor>Checks run every {config.checkEvery} steps. Change that or create a side agent from a terminal or the desktop app.</Text>
        )}
        {panelError !== undefined && <Text color="red">{panelError}</Text>}
        <Box flexDirection="row" gap={2}>
          <Button key="report" label="Open report" hotkey="r" plain onPress={() => openReport().catch(failed)} />
          <Button key="copy" label="Copy agents folder path" hotkey="c" plain onPress={press => $.ui.copy({ text: `${dir}/agents`, surface: press.surface }).then(() => $.ui.toast(`Copied ${dir}/agents`)).catch(failed)} />
          <Button key="copy-repo" label="Copy this repo's folder path" hotkey="p" plain onPress={press => $.ui.copy({ text: repoDir, surface: press.surface }).then(() => $.ui.toast(`Copied ${repoDir}`)).catch(failed)} />
        </Box>
      </Box>
    )
  })
}
