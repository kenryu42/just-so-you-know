export type Tag = "You should know" | "Heads up"

export type Proposed =
  | { kind: "none" }
  | { kind: "unparsable" }
  | { kind: "line"; line: string; tag: Tag; explanation?: string }

const ANSI = new RegExp(
  String.raw`[\u001B\u009B][[\]()#;?]*` +
    String.raw`(?:(?:(?:(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*` +
    String.raw`|[a-zA-Z\d]+(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?` +
    String.raw`(?:\u0007|\u001B\|\u009C))` +
    String.raw`|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))`,
  "g",
)
const stripControl = (text: string) =>
  text
    .replace(/\p{Cs}/gu, "")
    .replace(ANSI, "")
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, "")
const oneLine = (text: string) =>
  text
    .replace(/[\x00-\x08\x0E-\x1F\x7F-\x9F]/g, "")
    .replace(/\s+/g, " ")
    .trim()

const LEARN = /^learn\s*:\s*/i
const EXPLAIN = /^explain:\s*/i
const BULLET = /^[-*•]\s+/
const MAX_LINE = 240
const QUOTES = [
  ['"', '"'],
  ["'", "'"],
  ["“", "”"],
  ["‘", "’"],
  ["`", "`"],
] as const
const CLOSERS = QUOTES.map(pair => pair[1]).join("")
const ENDS_A_SENTENCE = new RegExp(`[.!?…][${CLOSERS})\\]]*$`)
const ENDS_WITH_QUESTION = new RegExp(`\\?[${CLOSERS}]?$`)
const INLINE_TAG =
  /[.\s—–-]*\s\**tag\**\s*:\s*\**\s*(heads[\s-]*up|you should know)\W*$/i
const TAG_LABEL = new RegExp(
  String.raw`^[\s>*_"'“”‘’` +
    "`" +
    String.raw`]*tag[\s*_"'“”‘’` +
    "`" +
    String.raw`]*(?::\s*|[-–—](?:\s+|$))`,
  "i",
)

const withoutTrailingPeriod = (text: string) => text.replace(/\.+$/, "")
const unquoted = (text: string) => {
  const trimmed = withoutTrailingPeriod(text.trim())
  const isWrapped =
    trimmed.length >= 2 &&
    QUOTES.some(
      ([open, close]) =>
        trimmed.startsWith(open) &&
        trimmed.endsWith(close) &&
        !trimmed.slice(1, -1).includes(close),
    )
  return isWrapped ? withoutTrailingPeriod(trimmed.slice(1, -1).trim()) : trimmed
}
const isDeclined = (text: string) =>
  text === "" || /^none\s*(?:[.!?()[\]:;,-]|$)/i.test(text)
export const tagOf = (text: string): Tag =>
  /^\W*heads[\s-]*up\W*$/i.test(text) ? "Heads up" : "You should know"
export const lineKey = (line: string) => line.toLowerCase().replace(/\.$/, "")

export function parseProposed(reply: string): Proposed {
  const rows = reply.split("\n")
  const cleaned = rows.map(row => stripControl(row).trimStart())
  const learnAt = cleaned.findIndex(row => LEARN.test(row.replace(BULLET, "")))
  const explainOffset = cleaned
    .slice(learnAt + 1)
    .findIndex(row => EXPLAIN.test(row))
  const hasExplain = learnAt !== -1 && explainOffset !== -1
  const explainAt = hasExplain ? learnAt + 1 + explainOffset : -1
  const explanationText = [
    (cleaned[explainAt] ?? "").replace(EXPLAIN, ""),
    ...rows.slice(explainAt + 1),
  ]
    .join("\n")
    .trim()
  const explanation = hasExplain ? explanationText || undefined : undefined
  const head = (hasExplain ? rows.slice(0, explainAt) : rows).map(row =>
    oneLine(stripControl(row)).replace(BULLET, ""),
  )
  const tagRow = head.find(row => TAG_LABEL.test(row)) ?? ""
  const tag = tagOf(tagRow.replace(TAG_LABEL, ""))

  const found = head.flatMap((row, at): Proposed[] => {
    if (!LEARN.test(row)) return []
    const first = row.replace(LEARN, "").trim()
    if (isDeclined(unquoted(first.replace(INLINE_TAG, ""))))
      return [{ kind: "none" }]
    let joined = first
    for (const next of head.slice(at + 1)) {
      const isEnd =
        next === "" ||
        LEARN.test(next) ||
        TAG_LABEL.test(next) ||
        ENDS_WITH_QUESTION.test(joined)
      if (isEnd) break
      joined += ` ${next}`
    }
    const quoted = unquoted(joined)
    const inline = INLINE_TAG.exec(quoted)
    const bare = inline === null ? quoted : unquoted(quoted.slice(0, inline.index))
    const line = ENDS_A_SENTENCE.test(bare) ? bare : `${bare}.`
    const lineTag = tagRow === "" && inline !== null ? tagOf(inline[1] ?? "") : tag
    return line.length <= MAX_LINE
      ? [{ kind: "line", line, tag: lineTag, explanation }]
      : []
  })
  return found[0] ?? { kind: "unparsable" }
}
