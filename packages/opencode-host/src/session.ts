import { createHash, randomUUID } from 'node:crypto'
import type { Json } from '@agent-workflows/runtime'
import type { ContentPart, Message } from './client.ts'

/** What the host writes into a session; every input carries `metadata.agw.kind`, so the checks are exact. */
export type InputKind = 'prompt' | 'steer' | 'resume'

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
  return kind === 'prompt' || kind === 'steer' || kind === 'resume'
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

/** The last non-empty assistant text after the prompt: the answer. */
export function finalText(messages: readonly Message[], promptId: string): string {
  const from = Math.max(0, promptIndex(messages, promptId))
  for (const m of messages.slice(from + 1).reverse()) {
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
