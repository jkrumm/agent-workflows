import { createHash } from 'node:crypto'
import type { Logger } from '@agent-workflows/runtime'
import { canonicalJson } from '../../canonical.ts'
import type { ToolCallRecord, ToolGrant } from '../../tool-gate/index.ts'
import type { LedgerEntry, ToolLedger } from './ledger.ts'
import { asRecord, message } from './util.ts'

/** The research agent's tools, as the model sees them, and the platform's `web.*` capability each runs. */
export const RESEARCH_TOOLS = {
  web_search: 'web.search',
  web_fetch: 'web.fetch',
  web_docs: 'web.docs',
  web_package: 'web.package',
} as const satisfies Record<string, string>

export const GATE_TOOLS = Object.keys(RESEARCH_TOOLS) as (keyof typeof RESEARCH_TOOLS)[]

/** Ledger writes per call: a blip is retried, a lasting failure is logged and the call's answer stands. */
const APPEND_ATTEMPTS = 3

/** `https://Example.com/a/#x` and `https://example.com/a` are the same page for grounding. */
export function normalizeUrl(raw: string): string {
  try {
    const url = new URL(raw.trim())
    url.hash = ''
    const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : ''
    return `${url.protocol}//${url.host.toLowerCase()}${path}${url.search}`
  } catch {
    return raw.trim()
  }
}

const digest = (text: string) => createHash('sha256').update(text).digest('hex')

/** The URLs a call read (`retrieved`) or only listed (`seen`), by tool; what grounding rests on. */
function urlsOf(call: ToolCallRecord): Partial<LedgerEntry> {
  if (!call.outcome.ok) return {}
  const out = asRecord(call.outcome.result)
  const { tool, args } = call
  if (tool === 'web_search') {
    return {
      seen: (Array.isArray(out.results) ? out.results : []).flatMap((r) => {
        const url = asRecord(r).url
        return typeof url === 'string' ? [url] : []
      }),
    }
  }
  if (tool === 'web_fetch') {
    return { retrieved: [args.url, out.url, out.finalUrl].filter((u): u is string => typeof u === 'string') }
  }
  if (tool === 'web_package' && typeof out.url === 'string') return { retrieved: [out.url] }
  if (tool === 'web_docs' && typeof out.source === 'string' && /^https?:/.test(out.source)) {
    return { retrieved: [out.source] }
  }
  return {}
}

/**
 * The research step's grant: its four tools, and a hook that appends every call to the ledger as the evidence the
 * step's `tools` reads. A ledger write that fails is retried and logged; it never turns a call that worked into a
 * failed one.
 */
export function researchGrant(ledger: ToolLedger, logger?: Logger): Pick<ToolGrant, 'tools' | 'onCall'> {
  const record = async (entry: LedgerEntry): Promise<void> => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await ledger.append(entry)
      } catch (error) {
        if (attempt < APPEND_ATTEMPTS) {
          await Bun.sleep(100 * attempt)
          continue
        }
        logger?.error('research tool gate: the ledger write failed; the call stands without its evidence row', {
          runId: entry.runId,
          tool: entry.tool,
          error: message(error),
        })
        return
      }
    }
  }
  /** The call's evidence row; if building it throws, a minimal row that says so, so a call is never absent from the ledger. */
  const rowOf = (call: ToolCallRecord): LedgerEntry => {
    try {
      return {
        runId: call.runId,
        stepId: call.stepId,
        tool: call.tool,
        argsDigest: digest(canonicalJson(call.args)),
        ok: call.outcome.ok,
        retrieved: [],
        seen: [],
        ...urlsOf(call),
        ...(call.outcome.ok ? {} : { error: call.outcome.error.slice(0, 300) }),
      }
    } catch (error) {
      logger?.error('research tool gate: the evidence row could not be built; a minimal row is written', {
        runId: call.runId,
        tool: call.tool,
        error: message(error),
      })
      return {
        runId: call.runId,
        stepId: call.stepId,
        tool: call.tool,
        argsDigest: 'unavailable',
        ok: call.outcome.ok,
        retrieved: [],
        seen: [],
        error: `evidence row failed: ${message(error)}`.slice(0, 300),
      }
    }
  }
  return { tools: RESEARCH_TOOLS, onCall: (call) => record(rowOf(call)) }
}

/** What a step's recorded calls add up to: URLs retrieved and seen (normalized), failed fetches, calls per tool. */
export function evidence(entries: LedgerEntry[]) {
  const retrieved = new Set<string>()
  const seen = new Set<string>()
  const counts: Record<string, number> = {}
  let failed = 0
  for (const entry of entries) {
    for (const url of entry.retrieved) retrieved.add(normalizeUrl(url))
    for (const url of entry.seen) seen.add(normalizeUrl(url))
    counts[entry.tool] = (counts[entry.tool] ?? 0) + 1
    if (!entry.ok && entry.tool === 'web_fetch') failed++
  }
  return { retrieved, seen, failed, counts }
}
