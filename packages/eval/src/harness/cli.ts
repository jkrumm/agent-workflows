import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { CheckCase, casesPath, evalDir, ReviewCase, readCases } from '../cases.ts'
import { agwCheckRunner, agwJudge, agwReviewRunner, psqlJournal } from './adapters/agw.ts'
import { legacyCheckRunner, legacyReviewRunner, usageTrackerCost } from './adapters/legacy.ts'
import { aggregateCheck, aggregateReview } from './aggregate.ts'
import { type Exec, exec as realExec } from './exec.ts'
import { cleanup, commandLine, materialize, setupSteps } from './materialize.ts'
import { type Report, renderAggregate, writeReport } from './report.ts'
import { type HarnessOptions, requestedDepth, runCheck, runReview } from './run.ts'
import { checkVerdict, reviewVerdict } from './verdict.ts'

const USAGE = `usage: bun packages/eval/src/harness/cli.ts review|check [flags]

  --ids a,b          only these case ids
  --limit N          the first N cases (after --ids)
  --concurrency N    cases in parallel (default 2: IU budget, host load)
  --rerun-legacy     also rerun agent-gateway on the same tree: measures legacy's own noise floor
  --judge            ask the decide capability about finding pairs the deterministic matcher is unsure of
  --depth router     let the new review's router pick the depth (default: the legacy run's recorded depth)
  --dry-run          materialize every case, print the plan and an IU estimate; calls neither side
  --keep             keep the case clones
  --resume <dir>     continue a run in <evalDir>/reports/<ts>; finished cases are skipped
  --seed N           bootstrap seed (default 1)

Case repos resolve under $AGW_EVAL_HOME (default $HOME).
Cases: $AGW_EVAL_DIR/<workflow>/cases.jsonl. Reports: $AGW_EVAL_DIR/reports/<ts>/{results.jsonl,report.json,report.md}.`

export interface CliDeps {
  env: Record<string, string | undefined>
  exec: Exec
  out: (line: string) => void
  err: (line: string) => void
  now?: () => Date
}

function parse(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      ids: { type: 'string' },
      limit: { type: 'string' },
      concurrency: { type: 'string', default: '2' },
      'rerun-legacy': { type: 'boolean', default: false },
      judge: { type: 'boolean', default: false },
      depth: { type: 'string', default: 'matched' },
      'dry-run': { type: 'boolean', default: false },
      keep: { type: 'boolean', default: false },
      resume: { type: 'string' },
      seed: { type: 'string', default: '1' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  })
  const workflow = positionals[0]
  const int = (name: string, raw: string | undefined, min: number) => {
    if (raw === undefined) return undefined
    const n = Number(raw)
    if (!Number.isInteger(n) || n < min) throw new Error(`--${name} must be an integer >= ${min}, got ${raw}`)
    return n
  }
  if (values.depth !== 'matched' && values.depth !== 'router') throw new Error('--depth must be matched or router')
  const depthMode: 'matched' | 'router' = values.depth === 'router' ? 'router' : 'matched'
  return {
    help: values.help,
    workflow,
    ids: values.ids
      ?.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    limit: int('limit', values.limit, 1),
    concurrency: int('concurrency', values.concurrency, 1) ?? 2,
    rerunLegacy: values['rerun-legacy'],
    judge: values.judge,
    depthMode,
    dryRun: values['dry-run'],
    keep: values.keep,
    resume: values.resume,
    seed: int('seed', values.seed, 0) ?? 1,
  }
}

type Flags = ReturnType<typeof parse>

function select<T extends { id: string }>(cases: T[], flags: Flags): T[] {
  const picked = flags.ids ? cases.filter((c) => flags.ids?.includes(c.id)) : cases
  return flags.limit ? picked.slice(0, flags.limit) : picked
}

const usd = (v: number) => `$${v.toFixed(4)}`

/** Materializes every case (and cleans up), prints the plan and what a real run would spend on IU. */
async function dryRun(
  workflow: 'review' | 'check',
  cases: (ReviewCase | CheckCase)[],
  flags: Flags,
  deps: CliDeps,
  home: string,
) {
  deps.out(
    `plan: ${workflow}, ${cases.length} cases (concurrency ${flags.concurrency}, depth ${flags.depthMode}, rerun-legacy ${flags.rerunLegacy ? 'on' : 'off'}, judge ${flags.judge ? 'on' : 'off'})`,
  )
  let ready = 0
  for (const c of cases) {
    const review = workflow === 'review' ? (c as ReviewCase) : undefined
    const patch = review ? review.diff : (c as CheckCase).patch
    const tree = await materialize({ repo: c.repo, baseSha: c.baseSha, patch }, { exec: deps.exec, home, setup: false })
    const what = review
      ? `depth ${requestedDepth(review, flags.depthMode) ?? 'router'}`
      : `commands ${(c as CheckCase).input.commands?.join(',') ?? 'default'}`
    const setup = tree.ok && workflow === 'check' ? setupSteps(tree.dir).map(commandLine) : []
    const state = tree.ok ? `ready${setup.length ? ` (setup: ${setup.join('; ')})` : ''}` : `skipped: ${tree.reason}`
    if (tree.ok) ready++
    deps.out(`  ${c.id}  ${c.repo}  base ${c.baseSha.slice(0, 12)}  ${what}  ${state}`)
    if (tree.dir) cleanup(tree.dir)
  }
  const costs = cases.map((c) => c.legacy.costUsd).filter((v): v is number => v !== null)
  const mean = costs.length ? costs.reduce((a, b) => a + b, 0) / costs.length : null
  deps.out(`ready ${ready}/${cases.length}`)
  if (mean === null) {
    deps.out('IU estimate: unknown (no recorded legacy cost on these cases)')
    return
  }
  const perSide = mean * ready
  const total = perSide * (flags.rerunLegacy ? 2 : 1)
  deps.out(
    `IU estimate: ${usd(total)} = legacy mean ${usd(mean)} (${costs.length}/${cases.length} cases priced) × ${ready} ready cases${flags.rerunLegacy ? ' × 2 sides (new + legacy rerun)' : ' (new side, assumed at legacy cost)'}${flags.judge ? ', plus judge calls' : ''}`,
  )
}

export async function main(argv: string[], deps: CliDeps): Promise<number> {
  const flags = parse(argv)
  if (flags.help || (flags.workflow !== 'review' && flags.workflow !== 'check')) {
    ;(flags.help ? deps.out : deps.err)(USAGE)
    return flags.help ? 0 : 2
  }
  const workflow: 'review' | 'check' = flags.workflow
  const home = deps.env.AGW_EVAL_HOME ?? deps.env.HOME ?? homedir()
  const path = casesPath(workflow, deps.env)
  if (!existsSync(path)) {
    deps.err(`no cases at ${path}`)
    return 2
  }
  const all = workflow === 'review' ? readCases(path, ReviewCase) : readCases(path, CheckCase)
  // An unknown id is a typo or a stale set: never a silent partial run.
  const known = new Set(all.map((c) => c.id))
  const unknown = flags.ids?.filter((id) => !known.has(id)) ?? []
  if (unknown.length) {
    deps.err(`unknown case ids in ${path}: ${unknown.join(', ')}`)
    return 2
  }
  const cases = select<ReviewCase | CheckCase>(all, flags)
  if (!cases.length) {
    deps.err('no cases selected')
    return 2
  }
  if (flags.dryRun) {
    await dryRun(workflow, cases, flags, deps, home)
    return 0
  }

  const now = deps.now ?? (() => new Date())
  const startedAt = now().toISOString()
  const runDir = flags.resume ?? join(evalDir(deps.env), 'reports', startedAt.replace(/[:.]/g, '-'))
  const options: HarnessOptions = {
    exec: deps.exec,
    home,
    concurrency: flags.concurrency,
    keep: flags.keep,
    depthMode: flags.depthMode,
    resultsPath: join(runDir, 'results.jsonl'),
    log: (line) => deps.err(line),
  }
  deps.err(`run directory: ${runDir}`)
  const journal = psqlJournal({ exec: deps.exec, env: deps.env })
  // usage-tracker lives under the real home, not the case-repo root (AGW_EVAL_HOME).
  const legacyCost = usageTrackerCost(
    deps.env.AGW_USAGE_TRACKER_DIR ?? join(deps.env.HOME ?? homedir(), '.local', 'share', 'usage-tracker'),
  )
  const agw = { exec: deps.exec, journal, bin: deps.env.AGW_BIN }
  const legacy = { exec: deps.exec, cost: legacyCost, bin: deps.env.AGW_LEGACY_BIN }
  const meta = {
    startedAt,
    depthMode: flags.depthMode,
    rerunLegacy: flags.rerunLegacy,
    judge: flags.judge,
    concurrency: flags.concurrency,
    seed: flags.seed,
  }

  let report: Report
  if (workflow === 'review') {
    const results = await runReview(
      cases as ReviewCase[],
      {
        next: agwReviewRunner(agw),
        ...(flags.rerunLegacy ? { legacy: legacyReviewRunner(legacy) } : {}),
        ...(flags.judge ? { judge: agwJudge({ exec: deps.exec, bin: deps.env.AGW_BIN }) } : {}),
      },
      options,
    )
    const aggregate = aggregateReview(results, flags.seed)
    report = {
      workflow,
      meta: { ...meta, finishedAt: now().toISOString() },
      aggregate,
      verdict: reviewVerdict(aggregate),
      results,
    }
  } else {
    const results = await runCheck(
      cases as CheckCase[],
      { next: agwCheckRunner(agw), ...(flags.rerunLegacy ? { legacy: legacyCheckRunner(legacy) } : {}) },
      options,
    )
    const aggregate = aggregateCheck(results, flags.seed)
    report = {
      workflow,
      meta: { ...meta, finishedAt: now().toISOString() },
      aggregate,
      verdict: checkVerdict(aggregate),
      results,
    }
  }
  writeReport(runDir, report)
  deps.out(renderAggregate(report))
  deps.out(`\nreport: ${join(runDir, 'report.md')}`)
  return 0
}

if (import.meta.main) {
  const code = await main(process.argv.slice(2), {
    env: process.env,
    exec: realExec,
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  }).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  })
  process.exit(code)
}
