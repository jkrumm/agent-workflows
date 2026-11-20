import { casesPath, PlainCase, writeCases } from '@agent-workflows/eval'
import { Pool } from 'pg'
import { IrisGistInput } from './workflows/iris-gist/schema.ts'
import { IrisTriageInput } from './workflows/iris-triage/schema.ts'

// `make eval-mine-iris`: the cases of the `iris-triage` and `iris-gist` suites, from the journal's recorded Iris calls
// (runs of purpose `iris`: `cap.triage`, `cap.llm.summarize`). The transcripts and replies are private, so the files are
// written under $AGW_EVAL_DIR (mode 0600) and never enter the repo; the output of this command names counts only.

export interface IrisRun {
  workflow: string
  inputHash: string
  input: unknown
}

/** The memo's route when it was only transcribed: it has no reply and Iris names it with this text. */
const TRANSCRIBE_ONLY = 'transcript only'

/** Every `step`-th element of `items`, `count` of them at most: a spread over the whole list, not its newest end. */
function spread<T>(items: T[], count: number): T[] {
  if (items.length <= count) return items
  const step = items.length / count
  return Array.from({ length: count }, (_, i) => items[Math.floor(i * step)] as T)
}

const caseId = (suite: string, run: IrisRun) => `${suite}-${run.inputHash.slice(0, 8)}`

/**
 * The cases of both suites from the recorded runs, newest first. One case per distinct input. Triage keeps every
 * transcribe-only memo (the path whose latency Iris waits on) up to `maxTranscribe`, and fills to `triage` with memos
 * that have a reply, spread over the whole history. A run whose input does not parse as the workflow's input is skipped.
 */
export function irisCases(
  runs: IrisRun[],
  { triage = 30, maxTranscribe = 14, gist = 30 }: { triage?: number; maxTranscribe?: number; gist?: number } = {},
) {
  const distinct = (workflow: string) => {
    const seen = new Set<string>()
    return runs.filter((r) => r.workflow === workflow && !seen.has(r.inputHash) && seen.add(r.inputHash))
  }
  const triageRuns = distinct('cap.triage').flatMap((run) => {
    const parsed = IrisTriageInput.safeParse(run.input)
    return parsed.success ? [{ run, input: parsed.data }] : []
  })
  const transcribe = triageRuns.filter((t) => t.input.destination.startsWith(TRANSCRIBE_ONLY))
  const kept = spread(transcribe, maxTranscribe)
  const replied = spread(
    triageRuns.filter((t) => !transcribe.includes(t)),
    Math.max(0, triage - kept.length),
  )
  const asCase = (suite: string, run: IrisRun, input: object) => ({
    id: caseId(suite, run),
    input: JSON.parse(JSON.stringify(input)),
    reference: {},
  })
  return {
    'iris-triage': [...kept, ...replied].map((t) => asCase('iris-triage', t.run, t.input)),
    'iris-gist': spread(
      distinct('cap.llm.summarize').flatMap((run) => {
        const parsed = IrisGistInput.safeParse(run.input)
        return parsed.success ? [asCase('iris-gist', run, parsed.data)] : []
      }),
      gist,
    ),
  }
}

async function main() {
  const url = process.env.AGW_PG_URL
  if (!url) throw new Error('AGW_PG_URL is not set: run it through `make eval-mine-iris`')
  const schema = process.env.AGW_PG_SCHEMA?.trim() || 'agw'
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)) throw new Error('AGW_PG_SCHEMA is not a valid schema name')
  const pool = new Pool({ connectionString: url, max: 1 })
  try {
    const { rows } = await pool.query<{ workflow: string; input_hash: string; input: unknown }>(
      `select workflow, input_hash, input from "${schema}".runs
       where purpose = 'iris' and status = 'done' and workflow in ('cap.triage', 'cap.llm.summarize')
       order by started_at desc`,
    )
    const sets = irisCases(rows.map((r) => ({ workflow: r.workflow, inputHash: r.input_hash, input: r.input })))
    for (const [suite, cases] of Object.entries(sets)) {
      writeCases(casesPath(suite), PlainCase, cases)
      console.log(`${suite}: ${cases.length} cases -> ${casesPath(suite)}`)
    }
  } finally {
    await pool.end()
  }
}

if (import.meta.main) await main()
