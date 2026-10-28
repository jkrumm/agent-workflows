import { createHash, randomUUID } from 'node:crypto'
import type { Json } from '@agent-workflows/runtime'
import type { ContentPart, Message } from './client.ts'

/** What the host writes into a session; every input carries `metadata.agw.kind`, so the checks are exact. */
export type InputKind = 'prompt' | 'steer' | 'resume' | 'nudge'

const digest = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 24)

/**
 * Deterministic message ids: the server dedupes a second post of the same id (measured, 2.0.32), so a re-sent
 * prompt or resume after a crash is a no-op on the server as well as in the host's own check.
 */
export function inputId(sessionId: string, kind: InputKind, salt = ''): string {
  return `msg_agw${kind[0]}_${digest(`${sessionId}\0${kind}\0${salt}`)}`
}

/** A steer's id: keyed by the runtime's signal row, else unique per call. Never by the text alone. */
export function steerId(sessionId: string, signalId?: string): string {
  return inputId(sessionId, 'steer', signalId === undefined ? `nonce:${randomUUID()}` : `signal:${signalId}`)
}

/**
 * The session id of the `generation`-th session for a step key. Generation 1 is the first attempt; a retry after a
 * failed attempt moves to the next one (the host skips generations whose session was already prompted).
 */
export function sessionIdFor(key: string, generation: number): string {
  return `ses_agw${digest(`${key}\0${generation}`)}`
}

const kindOf = (m: Message): string | undefined => m.metadata?.agw?.kind
const isInput = (m: Message) => {
  const kind = kindOf(m)
  return kind === 'prompt' || kind === 'steer' || kind === 'resume' || kind === 'nudge'
}

export type Outcome = 'succeeded' | 'failed' | 'interrupted' | 'unknown'

export type SessionState =
  | { kind: 'unprompted' }
  | { kind: 'running' }
  | { kind: 'done'; outcome: Outcome; error?: string }
  /** Not running, no idle after the last input: the server died mid-turn. `lastId` keys the resume. */
  | { kind: 'cutoff'; lastId: string }

export function promptIndex(messages: readonly Message[], promptId: string): number {
  return messages.findIndex((m) => m.id === promptId || (m.type === 'user' && kindOf(m) === 'prompt'))
}

const OUTCOMES = new Set(['succeeded', 'failed', 'interrupted'])

/**
 * Where a session stands, from its messages and the server's view. A session the server runs, or holds admitted
 * input for, is running, prompt projected or not. Done means the newest message is an `idle` written after the
 * host's last input; an idle without a known outcome is `unknown`, never a success.
 */
export function sessionState(
  messages: readonly Message[],
  view: { promptId: string; active: boolean; pending: boolean },
): SessionState {
  if (view.active || view.pending) return { kind: 'running' }
  const prompt = promptIndex(messages, view.promptId)
  const last = messages.at(-1)
  if (prompt < 0 || last === undefined) return { kind: 'unprompted' }
  let lastInput = prompt
  messages.forEach((m, i) => {
    if (isInput(m)) lastInput = Math.max(lastInput, i)
  })
  if (last.type === 'idle' && messages.length - 1 > lastInput) {
    const outcome: Outcome = last.outcome && OUTCOMES.has(last.outcome) ? last.outcome : 'unknown'
    const error = errorText(last.error)
    return error ? { kind: 'done', outcome, error } : { kind: 'done', outcome }
  }
  return { kind: 'cutoff', lastId: last.id }
}

function errorText(error: Message['error']): string | undefined {
  if (!error) return undefined
  return typeof error === 'string' ? error : (error.message ?? JSON.stringify(error))
}

const textOf = (m: Message) =>
  (m.content ?? [])
    .filter((p) => p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
    .join('')

/**
 * Whether an assistant message ended its turn. `finish` says so (`tool-calls` is mid-loop, anything else is the end).
 * A message without one is unknown, and a text-only one may be a preamble still streaming before its tool calls, so it
 * is not taken as ended; only an `idle` after it (handled by the caller) proves the turn is over.
 */
function finishedTurn(m: Message): boolean {
  return m.finish !== undefined && m.finish !== 'tool-calls'
}

/**
 * The last non-empty assistant text after the prompt: the answer. A nudge posted mid-turn is read in the running turn
 * (measured on 2.0.32: it lands after a message that finished `tool-calls`, and the reply after it ends the turn). One
 * that lands after the turn ended, after an `idle` or after a message that finished with anything but `tool-calls`
 * (`stop`), runs as a turn of its own; its reply answers the nudge, never the step, so the text stops before it, at
 * the last non-empty text there (a final `stop` message without text does not blank the answer). A message with no
 * `finish` counts as ended only when an `idle` follows it before the nudge.
 */
export function finalText(messages: readonly Message[], promptId: string): string {
  const from = Math.max(0, promptIndex(messages, promptId))
  let end = messages.length
  let turnEnded = false
  for (let i = from + 1; i < messages.length; i++) {
    const m = messages[i] as Message
    if (m.type === 'idle') turnEnded = true
    else if (m.type === 'assistant') turnEnded = finishedTurn(m)
    else if (kindOf(m) === 'nudge') {
      if (turnEnded) {
        end = i
        break
      }
    } else if (isInput(m)) turnEnded = false // a steer or a resume starts or continues a turn
  }
  for (const m of messages.slice(from + 1, end).reverse()) {
    if (m.type !== 'assistant') continue
    const text = textOf(m).trim()
    if (text) return text
  }
  return ''
}

/** A JSON answer, bare or in one fenced block; anything unparsable stays text and fails the runtime's schema. */
export function parseStructured(text: string): Json {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n?```/.exec(text)
  const body = (fenced?.[1] ?? text).trim()
  try {
    return JSON.parse(body) as Json
  } catch {
    return text
  }
}

export type ToolPart = ContentPart & { type: 'tool'; id: string; name: string }

/** Every tool part of the assistant messages after the prompt, in order. */
export function toolParts(messages: readonly Message[], promptId: string): ToolPart[] {
  const from = promptIndex(messages, promptId)
  if (from < 0) return []
  return messages
    .slice(from + 1)
    .filter((m) => m.type === 'assistant')
    .flatMap((m) => (m.content ?? []).filter((p): p is ToolPart => p.type === 'tool' && !!p.id && !!p.name))
}

/** Changes whenever a message or part is added or grows, a tool changes state, or a turn completes. */
export function activityFingerprint(messages: readonly Message[]): string {
  return messages
    .map((m) => {
      const parts = (m.content ?? []).map((p) => `${p.type}:${p.text?.length ?? 0}:${p.state?.status ?? ''}`)
      return `${m.id}|${m.type}|${m.time?.completed ?? ''}|${m.tokens?.output ?? ''}|${parts.join(',')}`
    })
    .join('\n')
}

/**
 * The session's messages, read incrementally: one full walk first, then one newest-first page per poll merged by
 * id (messages are append-only; the newest ones are the ones still changing). A page that does not reach back to a
 * known message means more arrived than a page holds, and the next read is a full walk again.
 */
export class SessionReader {
  private messages: Message[] = []
  private full = true

  constructor(
    private readonly source: {
      all(): Promise<Message[]>
      recent(limit: number): Promise<Message[]>
    },
    private readonly pageSize = 50,
  ) {}

  async read(): Promise<Message[]> {
    if (this.full) {
      this.messages = await this.source.all()
      this.full = false
      return this.messages
    }
    const page = (await this.source.recent(this.pageSize)).reverse()
    const index = new Map(this.messages.map((m, i) => [m.id, i]))
    const oldest = page[0]
    if (page.length === this.pageSize && oldest && !index.has(oldest.id)) {
      this.full = true
      return this.read()
    }
    for (const m of page) {
      const at = index.get(m.id)
      if (at === undefined) this.messages.push(m)
      else this.messages[at] = m
    }
    return this.messages
  }

  /** Forces the next read to walk everything (after a server restart, before the final usage read). */
  invalidate(): void {
    this.full = true
  }
}

/** How long a state has held; `since` resets when it changes. The cut-off and unprompted grace both use it. */
export class Persisting {
  private since: number | null = null

  constructor(private readonly now: () => number = Date.now) {}

  /** True once `holds` has been true for `graceMs` without a break. */
  check(holds: boolean, graceMs: number): boolean {
    if (!holds) {
      this.since = null
      return false
    }
    this.since ??= this.now()
    return this.now() - this.since >= graceMs
  }

  reset(): void {
    this.since = null
  }
}

/** Calls of one tool+input at which the host nudges the agent (DeepSeek Harness repeat-tool reminder: 3, 5, 8). */
export const NUDGE_AT = [3, 5, 8] as const

/** JSON with object keys sorted recursively; two inputs that differ only in key order are the same call. */
export function canonicalInput(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => canonicalInput(v ?? null)).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalInput(v)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/**
 * What makes two tool calls "the same": the tool name and the canonical JSON of its input. A part whose input is not
 * known yet (a `pending` part is still streaming it) has no key and is not counted: a count must never move between
 * keys as the input arrives.
 */
export function toolCallKey(part: ToolPart): string | null {
  const status = part.state?.status
  if (status !== 'running' && status !== 'completed' && status !== 'error') return null
  const input = part.state?.input
  if (input === undefined || input === null) return null
  return `${part.name}\0${canonicalInput(input)}`
}

/** Calls per tool+input key in one session, in first-seen order. Parts are unique by id, so a re-read counts once. */
export function repeatCounts(parts: readonly ToolPart[]): Map<string, number> {
  const counts = new Map<string, number>()
  const seen = new Set<string>()
  for (const part of parts) {
    const key = toolCallKey(part)
    if (key === null || seen.has(part.id)) continue
    seen.add(part.id)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

/** The nudge thresholds a count has reached: the highest one only, so a jump across 3 and 5 sends one note. */
export function nudgeThreshold(count: number): (typeof NUDGE_AT)[number] | null {
  let reached: (typeof NUDGE_AT)[number] | null = null
  for (const at of NUDGE_AT) if (count >= at) reached = at
  return reached
}

/** The deterministic id of the nudge for a tool+input key at a threshold; the server dedupes a second post. */
export function nudgeId(sessionId: string, key: string, at: number): string {
  return inputId(sessionId, 'nudge', `${digest(key)}:${at}`)
}

/** Per-session friction counters (concept §7 tier 1), derived from the session's messages alone. */
export type SessionCounters = {
  /** Tool parts that ended in `error`. */
  toolErrors: number
  /** The highest number of identical tool calls (same tool, same canonical input); 0 without tool calls. */
  repeatToolCalls: number
  /** Nudge notes the host appended. */
  nudges: number
  /**
   * Nudges that were due and could have been sent but are not in the session: failed or given up. A threshold counts
   * only when a later tool call followed it (the turn went on, so the host had a poll to send it) and no note for it or
   * a higher threshold of the same call is there (a jump across thresholds sends one note, for the highest).
   */
  nudgesMissed: number
}

/**
 * The counters of one session. Pure over the messages, so a re-attach, a re-read or a second call gives the same
 * numbers: nothing is accumulated in the host.
 */
export function sessionCounters(messages: readonly Message[], promptId: string, sessionId: string): SessionCounters {
  const parts = toolParts(messages, promptId)
  const counts = repeatCounts(parts)
  const present = new Set(messages.map((m) => m.id))
  // Walk the calls in order, noting at which one each call reached each threshold.
  const seen = new Map<string, number>()
  const reached: { key: string; at: (typeof NUDGE_AT)[number]; index: number }[] = []
  const counted = new Set<string>()
  parts.forEach((part, index) => {
    const key = toolCallKey(part)
    if (key === null || counted.has(part.id)) return
    counted.add(part.id)
    const n = (seen.get(key) ?? 0) + 1
    seen.set(key, n)
    const at = NUDGE_AT.find((threshold) => threshold === n)
    if (at !== undefined) reached.push({ key, at, index })
  })
  // Due and sendable: a later tool call followed (the turn went on past the threshold). Satisfied by a note for this
  // threshold or any higher one of the same call. Derived from the messages like the rest, so it survives a restart.
  const missed = reached.filter(({ key, at, index }) => {
    if (index >= parts.length - 1) return false // the last call of the session: the host may never have polled after it
    return !NUDGE_AT.some((t) => t >= at && present.has(nudgeId(sessionId, key, t)))
  }).length
  return {
    toolErrors: parts.filter((p) => p.state?.status === 'error').length,
    repeatToolCalls: Math.max(0, ...counts.values()),
    nudges: messages.filter((m) => kindOf(m) === 'nudge').length,
    nudgesMissed: missed,
  }
}
