import type { Finding, Verdict } from "./finding"

const VERDICT_LABELS: Record<Verdict | "pending" | "undelivered", string> = {
  helped: "Helped",
  acknowledged: "Acknowledged",
  already_aware: "Already aware",
  ignored: "No reaction",
  pending: "Waiting",
  undelivered: "Not delivered",
}

const escape = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")

const inline = (text: string) =>
  escape(text)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")

const explanationHtml = (text: string) =>
  text
    .split(/\n{2,}|\n(?=[*-] )/)
    .map(block => block.trim())
    .filter(block => block !== "")
    .map(block =>
      /^[*-] /.test(block)
        ? `<li>${inline(block.replace(/^[*-] /, ""))}</li>`
        : `<p>${inline(block.replace(/\n/g, " "))}</p>`,
    )
    .join("")
    .replace(/(<li>.*?<\/li>)+/g, list => `<ul>${list}</ul>`)

const stateOf = (finding: Finding) =>
  finding.deliveryError !== undefined ? "undelivered" : (finding.verdict ?? "pending")

const when = (ms: number) =>
  new Date(ms).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })

const entry = (finding: Finding) => {
  const state = stateOf(finding)
  const reaction =
    state === "undelivered"
      ? escape(finding.deliveryError ?? "")
      : state === "pending"
        ? "The main agent has not answered yet."
        : escape(finding.evidence ?? "")
  return `<li class="note" data-state="${state}">
  <div class="meta">
    <time>${escape(when(finding.sharedAt))}</time>
    <span class="project">${escape(finding.project || "unknown project")}</span>
    <span class="agent">${escape(finding.agent)}</span>
    <span class="tag">${escape(finding.tag)}</span>
  </div>
  <div class="body">
    <p class="line">${inline(finding.line)}</p>
    ${finding.explanation ? `<details><summary>What the side agent explained</summary><div class="explain">${explanationHtml(finding.explanation)}</div></details>` : ""}
    <div class="reaction"><span class="pill" data-state="${state}">${VERDICT_LABELS[state]}</span><span class="evidence">${reaction}</span></div>
  </div>
</li>`
}

export function reportHtml(findings: readonly Finding[], generatedAt: number) {
  const states = ["helped", "acknowledged", "already_aware", "ignored", "pending", "undelivered"] as const
  const counts = states.map(state => ({
    state,
    count: findings.filter(finding => stateOf(finding) === state).length,
  }))
  const sessions = new Set(findings.map(finding => finding.sessionId)).size
  const bar = counts
    .filter(item => item.count > 0)
    .map(
      item =>
        `<span class="seg" data-state="${item.state}" style="flex-grow:${item.count}" title="${VERDICT_LABELS[item.state]}: ${item.count}"></span>`,
    )
    .join("")
  const filters = [
    `<button type="button" class="chip" aria-pressed="true" data-filter="all">All <b>${findings.length}</b></button>`,
    ...counts
      .filter(item => item.count > 0)
      .map(
        item =>
          `<button type="button" class="chip" aria-pressed="false" data-filter="${item.state}"><i data-state="${item.state}"></i>${VERDICT_LABELS[item.state]} <b>${item.count}</b></button>`,
      ),
  ].join("")
  const agents = [...new Set(findings.map(finding => finding.agent))].sort()
  const agentRows = agents
    .map(agent => {
      const own = findings.filter(finding => finding.agent === agent)
      const cells = states.map(state => `<td>${own.filter(finding => stateOf(finding) === state).length}</td>`).join("")
      return `<tr><th scope="row">${escape(agent)}</th><td>${own.length}</td>${cells}</tr>`
    })
    .join("")
  const agentTable = `<div class="agents-wrap"><table class="agents"><thead><tr><th scope="col">Side agent</th><th scope="col">Notes</th>${states.map(state => `<th scope="col">${VERDICT_LABELS[state]}</th>`).join("")}</tr></thead><tbody>${agentRows}</tbody></table></div>`
  const list = [...findings].sort((a, b) => b.sharedAt - a.sharedAt).map(entry).join("\n")

  return `<title>Just So You Know</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,700&family=Atkinson+Hyperlegible:ital,wght@0,400;0,700;1,400&family=JetBrains+Mono:wght@400;500&display=swap">
<style>
/* A ledger of passed notes: summary strip, then one row per note with its meta in a narrow left column. */
:root {
  --bg: #f3f6f8; --surface: #ffffff; --ink: #14212b; --muted: #5b6b78; --line: #dbe3e9; --accent: #0d6f7a;
  --helped: #2f8a4c; --acknowledged: #b7791f; --already: #5a72a0; --ignored: #b4483f; --pending: #8a96a1;
  --display: "Bricolage Grotesque", "Avenir Next", system-ui, sans-serif;
  --body: "Atkinson Hyperlegible", "Segoe UI", system-ui, sans-serif;
  --mono: "JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --bg: #0f171d; --surface: #16212a; --ink: #e4ecf1; --muted: #93a4b1; --line: #263540; --accent: #4fc0cb;
  --helped: #5cc27c; --acknowledged: #e0a84a; --already: #8fa6d6; --ignored: #e07a70; --pending: #7d8a95; color-scheme: dark;
} }
:root[data-theme="dark"] {
  --bg: #0f171d; --surface: #16212a; --ink: #e4ecf1; --muted: #93a4b1; --line: #263540; --accent: #4fc0cb;
  --helped: #5cc27c; --acknowledged: #e0a84a; --already: #8fa6d6; --ignored: #e07a70; --pending: #7d8a95; color-scheme: dark;
}
body { background: var(--bg); color: var(--ink); font: 16px/1.55 var(--body); }
.wrap { max-width: 920px; margin: 0 auto; padding-block: 40px 64px; padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); display: grid; gap: 28px; }
header { display: grid; gap: 8px; }
.eyebrow { font: 500 12px/1 var(--mono); letter-spacing: .08em; text-transform: uppercase; color: var(--accent); }
h1 { font: 700 clamp(32px, 6vw, 48px)/1.05 var(--display); margin: 0; text-wrap: balance; }
.sub { color: var(--muted); margin: 0; max-width: 62ch; }
.summary { display: grid; gap: 14px; }
.bar { display: flex; height: 12px; border-radius: 6px; overflow: hidden; background: var(--line); gap: 2px; }
.seg { min-width: 6px; }
.chips { display: flex; flex-wrap: wrap; gap: 8px; }
.chip { font: 14px/1 var(--body); color: var(--ink); background: var(--surface); border: 1px solid var(--line); border-radius: 999px; padding: 8px 12px; display: inline-flex; align-items: center; gap: 7px; cursor: pointer; }
.chip b { font: 500 13px/1 var(--mono); color: var(--muted); font-variant-numeric: tabular-nums; }
.chip[aria-pressed="true"] { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
.chip:focus-visible, summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.chip i { width: 9px; height: 9px; border-radius: 50%; }
[data-state="helped"] { --state: var(--helped); }
[data-state="acknowledged"] { --state: var(--acknowledged); }
[data-state="already_aware"] { --state: var(--already); }
[data-state="ignored"] { --state: var(--ignored); }
[data-state="pending"], [data-state="undelivered"] { --state: var(--pending); }
.seg, .chip i { background: var(--state); }
.notes { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--line); }
.note { display: grid; grid-template-columns: 168px minmax(0, 1fr); gap: 20px; padding-block: 20px; border-bottom: 1px solid var(--line); }
.meta { display: grid; align-content: start; gap: 4px; font: 13px/1.4 var(--mono); color: var(--muted); }
.meta time { color: var(--ink); font-variant-numeric: tabular-nums; }
.agent { color: var(--ink); }
.agents-wrap { overflow-x: auto; }
.agents { border-collapse: collapse; font: 13px/1.4 var(--mono); min-width: 100%; }
.agents th, .agents td { padding: 6px 10px; border-bottom: 1px solid var(--line); text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.agents th[scope="row"], .agents thead th:first-child { text-align: left; color: var(--ink); }
.agents thead th { color: var(--muted); font-weight: 500; }
.tag { justify-self: start; margin-top: 4px; font: 500 11px/1 var(--mono); letter-spacing: .06em; text-transform: uppercase; color: var(--accent); }
.body { display: grid; gap: 10px; min-width: 0; }
.line { font-size: 18px; line-height: 1.45; margin: 0; max-width: 65ch; }
details { color: var(--ink); }
summary { cursor: pointer; color: var(--accent); font-size: 14px; width: fit-content; }
.explain { margin-top: 8px; padding: 12px 16px; background: var(--surface); border: 1px solid var(--line); border-radius: 8px; max-width: 65ch; }
.explain p, .explain ul { margin: 0 0 8px; } .explain :last-child { margin-bottom: 0; } .explain ul { padding-left: 20px; }
code { font: 0.88em var(--mono); background: color-mix(in srgb, var(--line) 60%, transparent); padding: 1px 4px; border-radius: 4px; overflow-wrap: anywhere; }
.reaction { display: flex; flex-wrap: wrap; align-items: baseline; gap: 10px; }
.pill { font: 600 12px/1 var(--body); color: var(--state); border: 1.5px solid var(--state); border-radius: 999px; padding: 5px 10px; white-space: nowrap; }
.evidence { color: var(--muted); font-style: italic; min-width: 0; flex: 1 1 240px; }
.empty { color: var(--muted); padding-block: 24px; }
footer { color: var(--muted); font: 12px/1.5 var(--mono); }
@media (max-width: 620px) { .note { grid-template-columns: minmax(0, 1fr); gap: 10px; } .meta { grid-auto-flow: column; justify-content: start; gap: 12px; } .tag { margin-top: 0; } }
</style>
<div class="wrap">
  <header>
    <span class="eyebrow">Side agent notes</span>
    <h1>Just So You Know</h1>
    <p class="sub">Every note the side agents passed to the main agent, and how the main agent took it. ${findings.length} ${findings.length === 1 ? "note" : "notes"} across ${sessions} ${sessions === 1 ? "session" : "sessions"}.</p>
  </header>
  ${findings.length === 0 ? `<p class="empty">No notes yet. The side agents check about every 6 steps of a longer task and share only what clears a high bar.</p>` : `<section class="summary" aria-label="Reactions"><div class="bar">${bar}</div><div class="chips">${filters}</div>${agentTable}</section>
  <ul class="notes">
${list}
  </ul>`}
  <footer>Generated ${escape(when(generatedAt))} by the just-so-you-know mod.</footer>
</div>
<script>
document.querySelectorAll(".chip").forEach(chip => chip.addEventListener("click", () => {
  const filter = chip.dataset.filter
  document.querySelectorAll(".chip").forEach(other => other.setAttribute("aria-pressed", String(other === chip)))
  document.querySelectorAll(".note").forEach(note => { note.hidden = filter !== "all" && note.dataset.state !== filter })
}))
</script>
`
}
