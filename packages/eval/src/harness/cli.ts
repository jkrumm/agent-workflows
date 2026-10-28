import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { parseArgs } from 'node:util'
import { CheckCase, casesPath, evalDir, ReviewCase, readCases } from '../cases.ts'
import { agwCheckRunner, agwJudge, agwReviewRunner, psqlJournal } from './adapters/agw.ts'
import { legacyCheckRunner, legacyReviewRunner, usageTrackerCost } from './adapters/legacy.ts'
import { aggregateCheck, aggregateReview } from './aggregate.ts'
import { type Exec, exec as realExec } from './exec.ts'
import { cleanup, commandLine, materialize, setupSteps } from './materialize.ts'
import { type Report, renderAggregate, writeReport } from './report.ts'
import {
  DEFAULT_THRESHOLD,
  readRows,
  reproducibilityPath,
  reproducibleCases,
  type SelfAgreementOptions,
  type Side,
  selfAgreementCheck,
  selfAgreementReview,
} from './reproducibility.ts'
import { type HarnessOptions, requestedDepth, runCheck, runReview } from './run.ts'
import { checkVerdict, reviewVerdict } from './verdict.ts'

const USAGE = `usage: bun packages/eval/src/harness/cli.ts review|check [flags]
       bun packages/eval/src/harness/cli.ts self-agreement review|check [flags]

  --ids a,b          only these case ids
  --limit N          the first N cases (after --ids)
  --concurrency N    cases in parallel (default 2: IU budget, host load)
  --rerun-legacy     also rerun agent-gateway on the same tree: measures legacy's own noise floor
  --judge            ask the decide capability about finding pairs the deterministic matcher is unsure of
  --depth router     let the new review's router pick the depth (default: the legacy run's recorded depth)
  --dry-run          materialize every case, print the plan and an IU estimate; calls neither side
  --keep             keep the case clones
  --resume <run>     continue a run; finished cases are skipped. <run> is an absolute directory or a timestamp
                     (2026-10-28T09-00-00-000Z) resolved under <evalDir>/reports; anything else is an error
  --seed N           bootstrap seed (default 1)
  --agw-args="<args>"  review only: extra arguments (whitespace-split) for every \`agw review\` call, e.g.
                     --agw-args="--angle-variant shell" (the = is required: the value starts with a dash);
                     recorded in run.json (a resume must repeat it), report.json and the report.md header

self-agreement: reruns one side on every case and writes $AGW_EVAL_DIR/<workflow>/reproducibility.jsonl;
review|check then score blocking recall (check: failure recall) on the reproducible cases only.
  --side legacy|new  the side to rerun (default legacy: the recorded findings are legacy's)
  --runs N           reruns per case (default 2, at least 2); compared with each other and with the recorded run
  --threshold X      a case is reproducible when outcome agreement and blocking recall are both >= X (default ${DEFAULT_THRESHOLD})
  also: --ids --limit --concurrency --judge --depth --keep (the new side takes --agw-args for review)
  Cases already measured for this side with as many reruns are skipped; delete the file to measure again.

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
      'agw-args': { type: 'string' },
      side: { type: 'string', default: 'legacy' },
      runs: { type: 'string', default: '2' },
      threshold: { type: 'string', default: String(DEFAULT_THRESHOLD) },
      help: { type: 'boolean', short: 'h', default: false },
    },
  })
  const selfAgreement = positionals[0] === 'self-agreement'
  const workflow = selfAgreement ? positionals[1] : positionals[0]
  const int = (name: string, raw: string | undefined, min: number) => {
    if (raw === undefined) return undefined
    const n = Number(raw)
    if (!Number.isInteger(n) || n < min) throw new Error(`--${name} must be an integer >= ${min}, got ${raw}`)
    return n
  }
  if (values.depth !== 'matched' && values.depth !== 'router') throw new Error('--depth must be matched or router')
  const depthMode: 'matched' | 'router' = values.depth === 'router' ? 'router' : 'matched'
  if (values.side !== 'legacy' && values.side !== 'new') throw new Error('--side must be legacy or new')
  const side: Side = values.side === 'new' ? 'new' : 'legacy'
  const threshold = Number(values.threshold)
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error(`--threshold must be a number from 0 to 1, got ${values.threshold}`)
  }
  return {
    selfAgreement,
    side,
    runs: int('runs', values.runs, 2) ?? 2,
    threshold,
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
    agwArgs: values['agw-args']?.split(/\s+/).filter(Boolean) ?? [],
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
    `plan: ${workflow}, ${cases.length} cases (concurrency ${flags.concurrency}, depth ${flags.depthMode}, rerun-legacy ${flags.rerunLegacy ? 'on' : 'off'}, judge ${flags.judge ? 'on' : 'off'}${flags.agwArgs.length ? `, agw args ${flags.agwArgs.join(' ')}` : ''})`,
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

const RUN_FILE = 'run.json'

/**
 * `run.json` pins the run's `--agw-args` (an experiment arm) in its directory, so a resume cannot mix arms. A run
 * without the file predates the flag: its arguments were none. Writes the file for a fresh (or older) run.
 */
function agwArgsMismatch(runDir: string, agwArgs: string[], resuming: boolean): string | null {
  const path = join(runDir, RUN_FILE)
  if (resuming && existsSync(path)) {
    const stored: unknown = JSON.parse(readFileSync(path, 'utf8')).agwArgs
    const was = Array.isArray(stored) ? stored.map(String).join(' ') : ''
    return was === agwArgs.join(' ')
      ? null
      : `--resume ${runDir} was started with --agw-args "${was}" but this run has --agw-args "${agwArgs.join(' ')}"`
  }
  if (resuming && agwArgs.length) {
    return `--resume ${runDir} has no ${RUN_FILE} (started without --agw-args) but this run has --agw-args "${agwArgs.join(' ')}"`
  }
  mkdirSync(runDir, { recursive: true, mode: 0o700 })
  writeFileSync(path, `${JSON.stringify({ agwArgs })}\n`, { mode: 0o600 })
  return null
}

/** A run directory's name: `startedAt` with `:` and `.` replaced by `-`. */
const RUN_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/

/**
 * `--resume` names an existing run: an absolute path, or the timestamp of a run under `<evalDir>/reports`. A bare
 * name never resolves against the cwd (it once started writing into the repo checkout).
 */
export function resolveRunDir(value: string, reportsDir: string): string {
  const dir = isAbsolute(value) ? value : RUN_TIMESTAMP.test(value) ? join(reportsDir, value) : null
  if (dir === null) {
    throw new Error(`--resume takes an absolute path or a run timestamp under ${reportsDir}, got "${value}"`)
  }
  if (!existsSync(dir)) throw new Error(`--resume: no run directory at ${dir}`)
  return dir
}

/** `self-agreement`: reruns one side on every case and records which cases reproduce (see `reproducibility.ts`). */
async function selfAgreement(
  workflow: 'review' | 'check',
  cases: (ReviewCase | CheckCase)[],
  flags: Flags,
  deps: CliDeps,
  home: string,
): Promise<number> {
  const path = reproducibilityPath(workflow, deps.env)
  const options: SelfAgreementOptions = {
    exec: deps.exec,
    home,
    concurrency: flags.concurrency,
    keep: flags.keep,
    depthMode: flags.depthMode,
    resultsPath: path,
    log: (line) => deps.err(line),
    side: flags.side,
    runs: flags.runs,
    threshold: flags.threshold,
  }
  const agw = {
    exec: deps.exec,
    journal: psqlJournal({ exec: deps.exec, env: deps.env }),
    bin: deps.env.AGW_BIN,
    args: flags.agwArgs,
  }
  const legacy = {
    exec: deps.exec,
    cost: usageTrackerCost(
      deps.env.AGW_USAGE_TRACKER_DIR ?? join(deps.env.HOME ?? homedir(), '.local', 'share', 'usage-tracker'),
    ),
    bin: deps.env.AGW_LEGACY_BIN,
  }
  deps.err(`reproducibility file: ${path} (${flags.side}, ${flags.runs} reruns, threshold ${flags.threshold})`)
  const outcomes =
    workflow === 'review'
      ? await selfAgreementReview(
          cases as ReviewCase[],
          {
            runner: flags.side === 'legacy' ? legacyReviewRunner(legacy) : agwReviewRunner(agw),
            ...(flags.judge ? { judge: agwJudge({ exec: deps.exec, bin: deps.env.AGW_BIN }) } : {}),
          },
          options,
        )
      : await selfAgreementCheck(
          cases as CheckCase[],
          flags.side === 'legacy' ? legacyCheckRunner(legacy) : agwCheckRunner(agw),
          options,
        )
  const count = (status: string) => outcomes.filter((o) => o.status === status).length
  const rows = readRows(path).filter((r) => r.side === flags.side && cases.some((c) => c.id === r.id))
  const reproducible = rows.filter((r) => r.reproducible).length
  deps.out(
    `${workflow} self-agreement (${flags.side}, ${flags.runs} reruns, threshold ${flags.threshold}): measured ${count('measured')}, skipped ${count('skipped')}, errored ${count('error')}; ${reproducible} of ${rows.length} measured cases reproducible`,
  )
  deps.out(`file: ${path}`)
  return 0
}

export async function main(argv: string[], deps: CliDeps): Promise<number> {
  const flags = parse(argv)
  if (flags.help || (flags.workflow !== 'review' && flags.workflow !== 'check')) {
    ;(flags.help ? deps.out : deps.err)(USAGE)
    return flags.help ? 0 : 2
  }
  const workflow: 'review' | 'check' = flags.workflow
  if (workflow === 'check' && flags.agwArgs.length) {
    deps.err('--agw-args applies to review only: the arms of the review experiment are not check inputs')
    return 2
  }
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
  if (flags.selfAgreement) {
    const unsupported = [
      flags.resume !== undefined && '--resume (the reproducibility file is the resume point)',
      flags.rerunLegacy && '--rerun-legacy',
      flags.dryRun && '--dry-run',
      flags.side === 'legacy' && flags.agwArgs.length > 0 && '--agw-args (the new side only)',
    ].filter(Boolean)
    if (unsupported.length) {
      deps.err(`self-agreement does not take ${unsupported.join(', ')}`)
      return 2
    }
    return selfAgreement(workflow, cases, flags, deps, home)
  }
  if (flags.dryRun) {
    await dryRun(workflow, cases, flags, deps, home)
    return 0
  }

  const now = deps.now ?? (() => new Date())
  const startedAt = now().toISOString()
  const reports = join(evalDir(deps.env), 'reports')
  let runDir: string
  try {
    runDir =
      flags.resume === undefined ? join(reports, startedAt.replace(/[:.]/g, '-')) : resolveRunDir(flags.resume, reports)
  } catch (error) {
    deps.err(error instanceof Error ? error.message : String(error))
    return 2
  }
  const argsMismatch = agwArgsMismatch(runDir, flags.agwArgs, flags.resume !== undefined)
  if (argsMismatch) {
    deps.err(argsMismatch)
    return 2
  }
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
  const agw = { exec: deps.exec, journal, bin: deps.env.AGW_BIN, args: flags.agwArgs }
  const legacy = { exec: deps.exec, cost: legacyCost, bin: deps.env.AGW_LEGACY_BIN }
  const meta = {
    startedAt,
    depthMode: flags.depthMode,
    rerunLegacy: flags.rerunLegacy,
    judge: flags.judge,
    concurrency: flags.concurrency,
    seed: flags.seed,
    agwArgs: flags.agwArgs,
  }

  // Reproducibility data decides which cases the recorded findings can be scored on; none: every case counts.
  const reproducible = reproducibleCases(readRows(reproducibilityPath(workflow, deps.env)))
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
    const aggregate = aggregateReview(results, flags.seed, reproducible)
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
    const aggregate = aggregateCheck(results, flags.seed, reproducible)
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
