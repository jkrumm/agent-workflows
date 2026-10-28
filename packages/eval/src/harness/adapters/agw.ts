import { brief, type Exec, lastJson } from '../exec.ts'
import {
  CheckOutput,
  type CheckRunner,
  type Judge,
  type Located,
  ReviewOutput,
  type ReviewRunner,
  type RunCost,
  type RunJournal,
  type Spend,
} from '../ports.ts'

/**
 * The new platform through the installed `agw` CLI. `agw <workflow> --format json` prints the run state
 * (`{ runId, status, output }`); exit 10 means the wait budget ran out, and `agw run wait <runId>` resumes.
 * Every call carries `AGW_PURPOSE=eval`, so the spend is tagged. No timeout: agent runs take what they take.
 */

/** Exit code of a run still going when the CLI's wait budget ran out (`packages/cli/src/exit.ts`). */
const EXIT_PENDING = 10
const TERMINAL = new Set(['done', 'failed', 'cancelled'])

interface RunState {
  runId?: string
  status?: string
  output?: unknown
  error?: { kind?: string; message?: string }
}

export interface AgwOptions {
  exec: Exec
  journal: RunJournal
  bin?: string
  /** Waits for the journal row after the run ends (the record lands in runPost, a moment later). */
  journalAttempts?: number
  sleep?: (ms: number) => Promise<void>
}

const EVAL_ENV = { AGW_PURPOSE: 'eval' }

function readState(stdout: string): RunState {
  const value = lastJson(stdout)
  return typeof value === 'object' && value !== null ? value : {}
}

async function runWorkflow(options: AgwOptions, args: string[]): Promise<{ state: RunState; elapsedMs: number }> {
  const bin = options.bin ?? 'agw'
  const started = Date.now()
  let ran = await options.exec(bin, [...args, '--format', 'json'], { env: EVAL_ENV })
  let state = readState(ran.stdout)
  while (ran.code === EXIT_PENDING || (state.runId && state.status && !TERMINAL.has(state.status))) {
    if (!state.runId) throw new Error(`${bin} ${args[0]}: pending without a run id: ${brief(ran.stderr)}`)
    ran = await options.exec(bin, ['run', 'wait', state.runId, '--format', 'json'], { env: EVAL_ENV })
    state = readState(ran.stdout)
  }
  if (state.status !== 'done') {
    const why = state.error?.message ?? brief(ran.stderr || ran.stdout)
    throw new Error(`${bin} ${args[0]} run ${state.runId ?? '?'} ${state.status ?? `exit ${ran.code}`}: ${why}`)
  }
  return { state, elapsedMs: Date.now() - started }
}

async function spendOf(options: AgwOptions, runId: string | undefined, elapsedMs: number): Promise<Spend> {
  const attempts = options.journalAttempts ?? 20
  const sleep = options.sleep ?? Bun.sleep
  let row: RunCost | null = null
  // The run is paid for by now: a journal failure costs the cost figure, never the output.
  try {
    for (let i = 0; runId && i < attempts && !row; i++) {
      row = await options.journal.runCost(runId)
      if (!row) await sleep(1000)
    }
  } catch {
    row = null
  }
  if (!row) return { costUsd: null, costExact: false, wallMs: elapsedMs }
  return { costUsd: row.costUsd, costExact: row.unpricedCalls === 0, wallMs: row.wallMs ?? elapsedMs }
}

export function agwReviewRunner(options: AgwOptions): ReviewRunner {
  return {
    async review({ cwd, depth, context }) {
      const args = ['review', '--cwd', cwd, '--scope', 'uncommitted']
      if (depth) args.push('--depth', depth)
      if (context) args.push('--context', context)
      const { state, elapsedMs } = await runWorkflow(options, args)
      return {
        output: ReviewOutput.parse(state.output),
        spend: await spendOf(options, state.runId, elapsedMs),
        ...(state.runId ? { runId: state.runId } : {}),
      }
    },
  }
}

export function agwCheckRunner(options: AgwOptions): CheckRunner {
  return {
    async check({ cwd, commands }) {
      const args = ['check', '--cwd', cwd]
      if (commands?.length) args.push('--commands', JSON.stringify(commands))
      const { state, elapsedMs } = await runWorkflow(options, args)
      return {
        output: CheckOutput.parse(state.output),
        spend: await spendOf(options, state.runId, elapsedMs),
        ...(state.runId ? { runId: state.runId } : {}),
      }
    },
  }
}

/** The diff the judge reads is cut to this; `decide` caps its state at 60k characters. */
const JUDGE_DIFF_CHARS = 40_000

const describe = (label: string, f: Located) =>
  `Finding ${label}: ${f.file}${f.line ? `:${f.line}` : ''}\n${f.message.trim()}`

/**
 * The `decide` capability as a same-defect judge (`agw decide`). Blinded as in agent-gateway's
 * `replay-review-corpus.ts` judge: no side labels, and the two findings come in a content-derived order.
 */
export function agwJudge(options: { exec: Exec; bin?: string }): Judge {
  const bin = options.bin ?? 'agw'
  const questions = {
    same: {
      type: 'boolean',
      instructions:
        'Do finding A and finding B report the same defect in this diff (same root cause, same place), even if worded differently? Two different problems at the same spot are not the same defect.',
    },
  }
  return {
    async sameDefect({ a, b, diff }) {
      const [first, second] = a.message <= b.message ? [a, b] : [b, a]
      const state = [
        'A code review produced two findings on the diff below.',
        describe('A', first),
        describe('B', second),
        `Diff:\n${diff.slice(0, JUDGE_DIFF_CHARS)}`,
      ].join('\n\n')
      const ran = await options.exec(bin, ['decide', '--questions', JSON.stringify(questions), '--format', 'json'], {
        env: { AGW_PURPOSE: 'eval' },
        stdin: state,
      })
      if (ran.code !== 0) throw new Error(`${bin} decide exit ${ran.code}: ${brief(ran.stderr)}`)
      const body = lastJson(ran.stdout) as
        | { answers?: Record<string, { value?: boolean }>; output?: { answers?: Record<string, { value?: boolean }> } }
        | undefined
      const answer = (body?.answers ?? body?.output?.answers)?.same?.value
      if (typeof answer !== 'boolean') throw new Error(`${bin} decide: no boolean answer: ${brief(ran.stdout)}`)
      return answer
    },
  }
}

/** The journal's DB password ref, as `scripts/verify.sh` reads it (through `secrets-run`, never `op`). */
export const PG_PASSWORD_REF = 'op://mini/vps-dev/AGENT_WORKFLOWS_DB_PASSWORD'

export interface PsqlJournalOptions {
  exec: Exec
  env?: Record<string, string | undefined>
}

/**
 * Read-only journal port over `psql` (no driver dependency, same path as `make verify`). The session is
 * read-only (`default_transaction_read_only`); the run id is bound with psql's `:'id'`, never interpolated.
 */
export function psqlJournal(options: PsqlJournalOptions): RunJournal {
  const env = options.env ?? process.env
  const schema = env.AGW_PG_SCHEMA?.trim() || 'agw'
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error(`AGW_PG_SCHEMA is not a plain identifier: ${schema}`)
  let password: Promise<string> | undefined
  const readPassword = async () => {
    if (env.AGW_EVAL_PG_PASSWORD) return env.AGW_EVAL_PG_PASSWORD
    const ran = await options.exec('secrets-run', ['read', PG_PASSWORD_REF], { timeoutMs: 30_000 })
    const value = ran.stdout.trim()
    if (ran.code !== 0 || !value) throw new Error(`secrets-run read ${PG_PASSWORD_REF} failed: ${brief(ran.stderr)}`)
    return value
  }
  const query = `select status, coalesce(cost::text, ''), coalesce(wall_ms::text, ''), coalesce(tokens_input, 0), coalesce(tokens_output, 0), coalesce(tokens_cache_read, 0), coalesce(unpriced_calls, 0) from "${schema}".runs where id = :'id'`
  return {
    async runCost(runId) {
      // A rejected read is not cached: the next run tries again.
      password ??= readPassword().catch((error: unknown) => {
        password = undefined
        throw error
      })
      const ran = await options.exec(
        'psql',
        [
          '-h',
          env.AGW_EVAL_PG_HOST ?? '127.0.0.1',
          '-U',
          'agent_workflows',
          '-d',
          'agent_workflows',
          '-AtF',
          '|',
          '-v',
          'ON_ERROR_STOP=1',
          '-v',
          `id=${runId}`,
        ],
        {
          env: { PGPASSWORD: await password, PGOPTIONS: '-c default_transaction_read_only=on' },
          stdin: query,
          timeoutMs: 30_000,
        },
      )
      if (ran.code !== 0) throw new Error(`journal query failed: ${brief(ran.stderr)}`)
      const line = ran.stdout.trim()
      if (!line) return null
      const [status, cost, wall, input, output, cacheRead, unpriced] = line.split('|')
      if (!status || !TERMINAL.has(status) || !wall) return null
      return {
        costUsd: cost ? Number(cost) : null,
        wallMs: Number(wall),
        tokensInput: Number(input),
        tokensOutput: Number(output),
        tokensCacheRead: Number(cacheRead),
        unpricedCalls: Number(unpriced),
      }
    },
  }
}
