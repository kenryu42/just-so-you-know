import type { Tag } from "./parse"

export type Verdict = "helped" | "acknowledged" | "already_aware" | "ignored"

export type Finding = {
  id: string
  sessionId: string
  project: string
  turnId: string
  step: number
  agent: string
  sharedAt: number
  tag: Tag
  line: string
  explanation?: string
  promptsSurvived: number
  messageCount?: number
  verdict?: Verdict
  evidence?: string
  judgedAt?: number
  deliveryError?: string
}

export const VERDICTS: readonly Verdict[] = ["helped", "acknowledged", "already_aware", "ignored"]

const isFinding = (value: unknown): value is Finding =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as Finding).id === "string" &&
  typeof (value as Finding).sessionId === "string" &&
  typeof (value as Finding).agent === "string" &&
  typeof (value as Finding).line === "string" &&
  typeof (value as Finding).sharedAt === "number"

export const findingsOf = (value: unknown) =>
  Array.isArray(value) ? value.filter(isFinding) : []

export const isOpen = (finding: Finding) =>
  finding.verdict === undefined && finding.deliveryError === undefined
