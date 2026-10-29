import type { Logger } from '@agent-workflows/runtime'
import type { ToolCallRecord, ToolGrant } from '../../tool-gate/index.ts'
import type { LedgerEntry, ToolLedger } from '../research/ledger.ts'
import { ledgerGrant } from '../research/tools.ts'
import { asRecord } from '../research/util.ts'

/** The brain agent's tools, as the model sees them, and the platform's `brain.*` capability each runs. */
export const BRAIN_TOOLS = {
  brain_search: 'brain.search',
  brain_read: 'brain.read',
} as const satisfies Record<string, string>

/**
 * The form two vault paths are compared in for grounding: `./` stripped, Unicode NFC, case-folded. The tools print the
 * canonical path of a note they read; the agent may cite it with another case or in another Unicode form.
 */
export const foldPath = (path: string) =>
  path
    .trim()
    .replace(/^(\.\/)+/, '')
    .normalize('NFC')
    .toLowerCase()

/**
 * What a call read (`retrieved`: the canonical path, only when the note was found) or only listed (`seen`: search hit
 * paths). Grounding rests on `retrieved`: a citation needs a note the run opened, a search hit is not enough.
 */
function pathsOf(call: ToolCallRecord): Partial<LedgerEntry> {
  if (!call.outcome.ok) return {}
  const out = asRecord(call.outcome.result)
  if (call.tool === 'brain_read')
    return out.found === true && typeof out.path === 'string' ? { retrieved: [out.path] } : {}
  if (call.tool === 'brain_search') {
    const matches = Array.isArray(out.matches) ? out.matches : []
    const paths = matches.flatMap((m) => {
      const path = asRecord(m).path
      return typeof path === 'string' ? [path] : []
    })
    return { seen: [...new Set(paths)] }
  }
  return {}
}

/**
 * An attempt's grant: its two tools, recorded to the evidence ledger (the table research's gate writes; a note's path is
 * what `retrieved` holds here) by research's guarded hook, so a failed write or an unbuildable row never fails a call.
 */
export function brainGrant(ledger: ToolLedger, logger?: Logger): Pick<ToolGrant, 'tools' | 'onCall'> {
  return ledgerGrant({ tools: BRAIN_TOOLS, ledger, logger, label: 'brain', extract: pathsOf })
}

/** What an attempt's recorded calls add up to: notes read in reading order (once each, by `foldPath`), calls per tool. */
export function evidence(entries: LedgerEntry[]) {
  const read: string[] = []
  const have = new Set<string>()
  const counts: Record<string, number> = {}
  for (const entry of entries) {
    for (const path of entry.retrieved) {
      if (have.has(foldPath(path))) continue
      have.add(foldPath(path))
      read.push(path)
    }
    counts[entry.tool] = (counts[entry.tool] ?? 0) + 1
  }
  return { read, counts }
}
