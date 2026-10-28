import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { brief, type Exec, lastJson } from '../exec.ts'
import { CheckOutput, type CheckRunner, type LegacyCostSource, ReviewOutput, type ReviewRunner } from '../ports.ts'

/**
 * agent-gateway through `agw-legacy` (`agent-gateway/bin/agw-legacy.ts`). `--json` prints only the job result, so
 * the job is submitted with `--no-wait` (prints `{ jobId }`), awaited with `wait`, and read with `status` for its
 * start and end. The legacy review CLI takes no `--depth`: its rerun is always router-chosen.
 */

interface JobView {
  id: string
  status: string
  startedAt?: number | null
  finishedAt?: number | null
  createdAt?: number
  elapsedMs?: number
}

export interface LegacyOptions {
  exec: Exec
  cost: LegacyCostSource
  bin?: string
}

async function runJob(options: LegacyOptions, args: string[]) {
  const bin = options.bin ?? 'agw-legacy'
  const submit = await options.exec(bin, [...args, '--no-wait', '--json', '--caller', 'eval'])
  const jobId = (lastJson(submit.stdout) as { jobId?: string } | undefined)?.jobId
  if (submit.code !== 0 || !jobId) throw new Error(`${bin} ${args[0]} submit failed: ${brief(submit.stderr)}`)
  const waited = await options.exec(bin, ['wait', jobId, '--json', '--quiet'])
  const status = await options.exec(bin, ['status', jobId, '--json'])
  const job = lastJson(status.stdout) as JobView | undefined
  if (waited.code !== 0 || job?.status !== 'done') {
    throw new Error(`${bin} ${args[0]} job ${jobId} ${job?.status ?? `exit ${waited.code}`}: ${brief(waited.stderr)}`)
  }
  const startMs = job.startedAt ?? job.createdAt ?? Date.now()
  const endMs = job.finishedAt ?? Date.now()
  return { jobId, result: lastJson(waited.stdout), startMs, endMs, wallMs: job.elapsedMs ?? endMs - startMs }
}

export function legacyReviewRunner(options: LegacyOptions): ReviewRunner {
  return {
    async review({ cwd }) {
      const job = await runJob(options, ['review', '--repo', cwd, '--scope', 'uncommitted'])
      const cost = await options.cost.jobCost({
        jobId: job.jobId,
        tool: 'review',
        startMs: job.startMs,
        endMs: job.endMs,
      })
      return {
        output: ReviewOutput.parse(job.result),
        spend: { costUsd: cost.costUsd, costExact: cost.exact, wallMs: job.wallMs },
        runId: job.jobId,
      }
    },
  }
}

export function legacyCheckRunner(options: LegacyOptions): CheckRunner {
  return {
    async check({ cwd, commands }) {
      const args = ['check', '--repo', cwd]
      if (commands?.length) args.push('--commands', commands.join(','))
      const job = await runJob(options, args)
      const cost = await options.cost.jobCost({
        jobId: job.jobId,
        tool: 'check',
        startMs: job.startMs,
        endMs: job.endMs,
      })
      return {
        output: CheckOutput.parse(job.result),
        spend: { costUsd: cost.costUsd, costExact: cost.exact, wallMs: job.wallMs },
        runId: job.jobId,
      }
    },
  }
}

function readJsonl(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .flatMap((line) => {
      if (!line.trim()) return []
      try {
        return [JSON.parse(line) as Record<string, unknown>]
      } catch {
        return []
      }
    })
}

/**
 * Legacy cost from usage-tracker's sinks: session rows carry the job id (exact); IU rows (router, adversary, OCR)
 * carry none, so those with the job's tool prefix and a timestamp inside the job window are added and the cost is
 * marked approximate. Two legacy jobs running at once both claim the IU rows in their overlap.
 */
export function usageTrackerCost(dir: string): LegacyCostSource {
  return {
    async jobCost({ jobId, tool, startMs, endMs }) {
      const sessions = readJsonl(join(dir, 'agent-gateway-sessions.jsonl')).filter((r) => r.jobId === jobId)
      const iu = readJsonl(join(dir, 'agent-gateway-iu.jsonl')).filter((r) => {
        const ts = typeof r.ts === 'string' ? Date.parse(r.ts) : Number.NaN
        return String(r.tool ?? '').startsWith(`${tool}:`) && ts >= startMs && ts <= endMs
      })
      if (!sessions.length && !iu.length) return { costUsd: null, exact: false }
      const costOf = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
      const costUsd =
        sessions.reduce((s, r) => s + costOf(r.costUsd), 0) + iu.reduce((s, r) => s + costOf(r.cost_usd), 0)
      return { costUsd, exact: iu.length === 0 }
    },
  }
}
