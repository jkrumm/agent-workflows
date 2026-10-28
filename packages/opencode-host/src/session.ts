import { createHash } from 'node:crypto'
import type { Json } from '@agent-workflows/runtime'
import type { ContentPart, Message } from './client.ts'

/** What the host writes into a session; every input carries `metadata.agw.kind`, so the checks are exact. */
export type InputKind = 'prompt' | 'steer' | 'resume'

/**
 * Deterministic message ids: the server dedupes a second post of the same id (measured, 2.0.32), so a re-sent
 * prompt or resume after a crash is a no-op on the server as well as in the host's own check.
 */
export function inputId(sessionId: string, kind: InputKind, salt = ''): string {
  const digest = createHash('sha256').update(`${sessionId}\0${kind}\0${salt}`).digest('hex').slice(0, 24)
  return `msg_agw${kind[0]}_${digest}`
}

const kindOf = (m: Message): string | undefined => m.metadata?.agw?.kind
const isInput = (m: Message) => {
  const kind = kindOf(m)
  return kind === 'prompt' || kind === 'steer' || kind === 'resume'
}

export type SessionState =
  | { kind: 'unprompted' }
  | { kind: 'running' }
  | { kind: 'done'; outcome: 'succeeded' | 'failed' | 'interrupted'; error?: string }
  /** Not running, no idle after the last input: the server died mid-turn. `lastId` keys the resume. */
  | { kind: 'cutoff'; lastId: string }

export function promptIndex(messages: readonly Message[], promptId: string): number {
  return messages.findIndex((m) => m.id === promptId || (m.type === 'user' && kindOf(m) === 'prompt'))
}

/**
 * Where a session stands, from its messages and the server's view. Done means the newest message is an `idle`
 * written after the host's last input; a session the server runs, or holds admitted input for, is running.
 */
export function sessionState(
  messages: readonly Message[],
  view: { promptId: string; active: boolean; pending: boolean },
): SessionState {
  const prompt = promptIndex(messages, view.promptId)
  if (prompt < 0) return view.pending ? { kind: 'running' } : { kind: 'unprompted' }
  if (view.active || view.pending) return { kind: 'running' }
  let lastInput = prompt
  messages.forEach((m, i) => {
    if (isInput(m)) lastInput = Math.max(lastInput, i)
  })
  const last = messages.at(-1) as Message
  if (last.type === 'idle' && messages.length - 1 > lastInput) {
    const outcome = last.outcome ?? 'succeeded'
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
  for (let i = messages.length - 1; i > from; i--) {
    const m = messages[i] as Message
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
