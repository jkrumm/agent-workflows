import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { z } from 'zod'

/**
 * Eval cases (concept §6). They hold diffs and findings from private and work repos, so they never enter this
 * public repo: they live under `$AGW_EVAL_DIR` (default `~/.local/share/agent-workflows/eval`), one
 * `<workflow>/cases.jsonl` per workflow. Only aggregate numbers are committed.
 */
export function evalDir(env: Record<string, string | undefined> = process.env): string {
  return env.AGW_EVAL_DIR?.trim() || join(homedir(), '.local', 'share', 'agent-workflows', 'eval')
}

export function casesPath(workflow: string, env: Record<string, string | undefined> = process.env) {
  return join(evalDir(env), workflow, 'cases.jsonl')
}

export const Severity = z.enum(['blocking', 'improvement', 'discussion'])

/** One finding as agent-gateway's review reports it (`REVIEW_OUTPUT` v2); `angle` names the reviewer. */
export const Finding = z
  .object({
    severity: Severity,
    file: z.string(),
    line: z.number().int().optional(),
    message: z.string(),
    angle: z.string(),
  })
  .strict()
export type Finding = z.infer<typeof Finding>

export const ReviewOutcome = z.enum(['clean', 'actionable', 'needs-human'])
export const Depth = z.enum(['light', 'standard', 'deep'])

/** What a recorded run cost and how long it took; `null` when the record does not say. */
const Spend = {
  costUsd: z.number().nonnegative().nullable(),
  /** `false` when part of the cost was matched to the job by time window (router, adversary and OCR rows carry no job id). */
  costExact: z.boolean(),
  wallMs: z.number().int().nonnegative().nullable(),
}

export const ReviewCase = z
  .object({
    /** The legacy job id. */
    id: z.string().min(1),
    source: z.enum(['corpus-2026-10-19', 'jobs-db']),
    createdAt: z.iso.datetime(),
    /** The repo's path relative to `$HOME` (`SourceRoot/dotfiles`), never absolute. */
    repo: z.string().regex(/^(SourceRoot|IuRoot)\/[^/]+$/),
    /** The legacy call's input, minus `cwd`. */
    input: z
      .object({
        scope: z.string().optional(),
        pr: z.number().int().positive().optional(),
        branch: z.string().optional(),
        depth: Depth.optional(),
        context: z.string().optional(),
        angles: z.array(z.string()).optional(),
      })
      .strict(),
    /** The commit the diff applies to; the harness checks it out and applies `diff` as uncommitted changes. */
    baseSha: z.string().regex(/^[0-9a-f]{40}$/),
    headSha: z
      .string()
      .regex(/^[0-9a-f]{40}$/)
      .optional(),
    /** `true` when `baseSha` was inferred (the last commit before `createdAt`), not recorded. */
    baseInferred: z.boolean(),
    diff: z.string().min(1),
    legacy: z
      .object({
        outcome: ReviewOutcome,
        depth: Depth.nullable(),
        findings: z.array(Finding),
        testGaps: z.array(z.string()),
        /** Reviewers that failed in the legacy run (`(review pipeline)` discussions). */
        failedAngles: z.array(z.string()),
        ...Spend,
      })
      .strict(),
  })
  .strict()
export type ReviewCase = z.infer<typeof ReviewCase>

export const CheckStepName = z.enum(['format', 'lint', 'typecheck', 'test', 'fallow', 'check'])

export const CheckCase = z
  .object({
    id: z.string().min(1),
    /** `jobs-db`: a recorded legacy run; `synthetic`: a known-red or known-green state built for the set. */
    source: z.enum(['jobs-db', 'synthetic']),
    createdAt: z.iso.datetime(),
    repo: z.string().regex(/^(SourceRoot|IuRoot)\/[^/]+$/),
    input: z
      .object({
        commands: z.array(z.string()).optional(),
        stepTimeoutSeconds: z.number().int().positive().optional(),
      })
      .strict(),
    baseSha: z.string().regex(/^[0-9a-f]{40}$/),
    baseInferred: z.boolean(),
    /** Uncommitted changes applied on `baseSha` before the check runs; absent for a clean tree. */
    patch: z.string().optional(),
    legacy: z
      .object({
        passed: z.boolean(),
        steps: z.array(
          z.object({ name: CheckStepName, passed: z.boolean(), errors: z.array(z.string()).optional() }).strict(),
        ),
        ...Spend,
      })
      .strict(),
  })
  .strict()
export type CheckCase = z.infer<typeof CheckCase>

/** Parses a JSONL file line by line; a bad line throws with its line number. */
export function readCases<T extends z.ZodType>(path: string, schema: T): z.infer<T>[] {
  const lines = readFileSync(path, 'utf8').split('\n')
  const cases: z.infer<T>[] = []
  lines.forEach((line, index) => {
    if (line.trim() === '') return
    const parsed = schema.safeParse(JSON.parse(line))
    if (!parsed.success) throw new Error(`${path}:${index + 1}: ${z.prettifyError(parsed.error)}`)
    cases.push(parsed.data)
  })
  return cases
}

/** Validates every case, then writes the file whole (mode 0600: the cases hold private code). */
export function writeCases<T extends z.ZodType>(path: string, schema: T, cases: unknown[]): void {
  const lines = cases.map((c) => JSON.stringify(schema.parse(c)))
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, lines.length ? `${lines.join('\n')}\n` : '', { mode: 0o600 })
}

/**
 * A case of a workflow that needs no tree (research questions): the workflow input as it runs, and the reference its
 * scorer validates (`Scorer.reference`). The eval run starts it as is; `--args` win over `input`.
 */
export const PlainCase = z
  .object({
    id: z.string().min(1),
    input: z.record(z.string(), z.json()),
    reference: z.json(),
  })
  .strict()
export type PlainCase = z.infer<typeof PlainCase>
