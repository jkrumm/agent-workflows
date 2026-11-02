import { homedir } from 'node:os'
import { exec as bunExec } from '@agent-workflows/eval'
import { defineWorkflow, type Json, WorkflowError } from '@agent-workflows/runtime'
import { z } from 'zod'
import type { HostWorkflow } from '../../operations.ts'
import { IMPORTED_REVIEW_ID, ImportedFinding } from '../review/imported.ts'
import {
  type CaseResult,
  CaseResult as CaseResultSchema,
  consoleLogger,
  DEFAULT_CONCURRENCY,
  errorText,
  type EvalRunOptions,
  RECORD_SETTLE_MS,
  replay,
  RunSummary,
  select,
  summarize,
} from './run.ts'
import type { EvalSlot } from './slot.ts'
import { type EvalCase, readSuite, type Suites } from './suites.ts'

export const EVAL_IMPORT_ID = 'eval.import'

/** How many bad entries one refusal names. */
const MAX_PROBLEMS = 10

/**
 * A suite's importer: the internal workflow that turns one case's external findings into the output the suite's scorer
 * reads, and the shape of a finding in the import file. A suite without an entry here cannot be imported.
 */
interface Importer {
  /** The workflow each case runs as (`purpose: eval`, scored by its own scorer). */
  target: string
  finding: z.ZodType
  /** True when the scorer sends these findings to the judge (one call for the case). */
  judged(findings: unknown[]): boolean
}

const IMPORTERS: Record<string, Importer> = {
  review: { target: IMPORTED_REVIEW_ID, finding: ImportedFinding, judged: (findings) => findings.length > 0 },
}

/** The workflows an import runs its cases as: their cost and wall time are not measured (compare reads this). */
export const IMPORT_TARGETS: ReadonlySet<string> = new Set(Object.values(IMPORTERS).map((i) => i.target))

/** The suites that have an importer, sorted; empty when the host serves none. */
export function importableSuites(suites: Suites): string[] {
  return [...suites.keys()].filter((id) => id in IMPORTERS).sort()
}

/** The `agw eval import` input over the suites that have an importer. */
export const evalImportInput = (ids: [string, ...string[]]) =>
  z
    .object({
      workflow: z.enum(ids).describe('The suite to import findings for (its cases are the ground truth)'),
      label: z
        .string()
        .trim()
        .min(1)
        .describe('The external arm’s name, e.g. "native-code-review-high": its own fingerprint, which compare picks'),
      findings: z
        .record(z.string(), z.array(z.unknown()))
        .describe(
          'Case id → findings, a JSON file: [{"file","line"?,"endLine"?,"message","tag":"important"|"nit"|"pre-existing"}]. An empty list is a review that found nothing',
        ),
      ids: z.string().optional().describe('Comma-separated case ids to import (first); an unknown id is an error'),
      concurrency: z
        .number()
        .int()
        .min(1)
        .max(8)
        .optional()
        .describe(`Cases scored at once, default ${DEFAULT_CONCURRENCY} (judge rate limits)`),
      yes: z
        .boolean()
        .optional()
        .describe('Score the findings: spends judge calls. Without it, only the plan; nothing runs'),
    })
    .strict()

export const evalImportOutput = (ids: [string, ...string[]]) =>
  z.object({
    workflow: z.enum(ids),
    label: z.string(),
    ran: z.boolean().describe('False: the plan only (no --yes)'),
    plan: z.object({
      ids: z.array(z.string()).describe('Cases to score: selected, and in the file'),
      missing: z.array(z.string()).describe('Selected suite cases the file has no entry for: not run, not scored as 0'),
      findings: z.number().int().describe('Findings across the cases to score'),
      judgeCalls: z.number().int().describe('Judge calls the scoring makes: one per case with a finding'),
    }),
    fingerprints: z.array(z.string()).describe('The fingerprints the case runs ran on (one, unless a deploy crossed)'),
    cases: z.array(CaseResultSchema),
    summary: RunSummary,
  })

/** The file's entries parsed by the importer's finding shape; a problem names the case and the index. */
function parseFindings(importer: Importer, findings: Record<string, unknown[]>): Record<string, Json[]> {
  const problems: string[] = []
  const parsed: Record<string, Json[]> = {}
  for (const [caseId, list] of Object.entries(findings)) {
    parsed[caseId] = []
    list.forEach((entry, index) => {
      const result = importer.finding.safeParse(entry)
      if (result.success) parsed[caseId]?.push(result.data as Json)
      else problems.push(`case ${caseId}, finding ${index}: ${z.prettifyError(result.error)}`)
    })
  }
  if (problems.length > 0) {
    const more = problems.length > MAX_PROBLEMS ? `\n… and ${problems.length - MAX_PROBLEMS} more` : ''
    throw new WorkflowError('invalid_input', `bad findings:\n${problems.slice(0, MAX_PROBLEMS).join('\n')}${more}`)
  }
  return parsed
}

/**
 * `agw eval import <workflow> --label <name> --findings <file>` (`docs/review-v2.md` §Arms): scores an external arm's
 * findings, written elsewhere (the native `/code-review` session per case), against the suite's ground truth with the
 * suite's own scorer. It is an eval run whose case runs are the importer's internal workflow (no model call), so
 * resume, idempotency, `purpose: eval`, the `regression` score and the cost roll-up behave as in `agw eval run`. The
 * label is the arm (`params.external`): each label has its own fingerprint. Without `--yes` it answers the plan and
 * spends nothing.
 */
export function createEvalImport(
  slot: EvalSlot,
  suites: Suites,
  importable: [string, ...string[]],
  options: EvalRunOptions = {},
): HostWorkflow {
  const env = options.env ?? process.env
  const exec = options.exec ?? bunExec
  const home = env.AGW_EVAL_HOME?.trim() || homedir()

  const workflow = defineWorkflow({
    id: EVAL_IMPORT_ID,
    version: '2026-11-02.1',
    input: evalImportInput(importable),
    output: evalImportOutput(importable),
    // Each label is an arm of its own: a distinct fingerprint, inherited by every case run below.
    arm: (input) => ({ params: { external: input.label } }),
    async run(ctx, input) {
      const importer = IMPORTERS[input.workflow] as Importer
      const plan = await ctx.step('plan', async () => {
        slot.target(importer.target) // served here, with a scorer
        let suite: EvalCase[]
        try {
          suite = readSuite(suites, input.workflow, env)
        } catch (error) {
          throw new WorkflowError('invalid_input', `${input.workflow} cases: ${errorText(error)}`)
        }
        const known = new Set(suite.map((c) => c.id))
        const unknown = Object.keys(input.findings).filter((id) => !known.has(id))
        if (unknown.length > 0) throw new WorkflowError('invalid_input', `unknown case ids: ${unknown.join(', ')}`)
        const findings = parseFindings(importer, input.findings)
        const selected = select(suite, input.ids, undefined).map((c) => c.id)
        const ids = selected.filter((id) => id in findings)
        if (ids.length === 0)
          throw new WorkflowError('invalid_input', 'the file has no findings for the selected cases')
        return { ids, missing: selected.filter((id) => !(id in findings)), findings }
      })
      const planned = {
        workflow: input.workflow,
        label: input.label,
        plan: {
          ids: plan.ids,
          missing: plan.missing,
          findings: plan.ids.reduce((n, id) => n + (plan.findings[id]?.length ?? 0), 0),
          judgeCalls: plan.ids.filter((id) => importer.judged(plan.findings[id] ?? [])).length,
        },
        fingerprints: [],
      }
      if (!input.yes) return { ...planned, ran: false, cases: [], summary: summarize([]) }

      const results: CaseResult[] = await ctx.step('cases', ({ signal }) => {
        const references = new Map(readSuite(suites, input.workflow, env).map((c) => [c.id, c.reference]))
        // No tree: the findings are the input, and the scorer reads the commit's diff from the owner's checkout.
        const cases: EvalCase[] = plan.ids.map((id) => ({
          id,
          tree: null,
          setup: false,
          input: () => ({ caseId: id, label: input.label, findings: plan.findings[id] ?? [] }),
          reference: references.get(id) as Json,
        }))
        return replay(
          {
            slot,
            exec,
            home,
            tmpRoot: options.tmpRoot,
            logger: options.logger ?? consoleLogger,
            recordSettleMs: options.recordSettleMs ?? RECORD_SETTLE_MS,
          },
          {
            evalRunId: ctx.runId,
            target: slot.target(importer.target),
            cases,
            ids: plan.ids,
            args: {},
            concurrency: input.concurrency ?? DEFAULT_CONCURRENCY,
            signal,
          },
        )
      })
      const fingerprints = [...new Set(results.flatMap((c) => (c.fingerprint ? [c.fingerprint] : [])))]
      return { ...planned, ran: true, fingerprints, cases: results, summary: summarize(results) }
    },
  })
  return {
    workflow,
    summary:
      'Score an external arm’s findings (case id → findings) against the suite’s ground truth (--yes spends judge calls)',
    cli: { positional: ['workflow'], defaultFormat: 'json' },
  }
}
