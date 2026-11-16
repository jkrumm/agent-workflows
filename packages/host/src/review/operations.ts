// `agw review prepare|cancel|submit|dispose|status|route|covered|stats`: host operations like the fleet's, no journal run.
import { type ResolvedCliSpec, withCli } from '@agent-workflows/capabilities'
import { ORPCError, os } from '@orpc/server'
import type { z } from 'zod'
import type { HostContext, HostOperation } from '../operations.ts'
import type { ReviewService } from './index.ts'
import {
  CancelInput,
  CancelOutput,
  CoveredInput,
  CoveredOutput,
  DisposeInput,
  DisposeOutput,
  PrepareInput,
  PrepareOutput,
  ReviewError,
  ReviewOutputV4,
  RouteInput,
  RouteOutput,
  StatsInput,
  StatsOutput,
  StatusInput,
  StatusOutput,
  SubmitInput,
} from './schema.ts'

const base = os.$context<HostContext>()

const cliOf = (command: string, extra: Partial<ResolvedCliSpec> = {}): ResolvedCliSpec => ({
  command: ['review', command],
  positional: [],
  mutating: false,
  defaultFormat: 'json',
  kind: 'capability',
  ...extra,
})

/**
 * Postgres refusing a connection because the role is at its limit (SQLSTATE 53300; a wrapper may keep only the text).
 * The role is shared with `make check`, so this is a passing state of the host, not a failure of the request.
 */
export function isConnectionExhausted(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  if ((error as { code?: unknown }).code === '53300') return true
  return error instanceof Error && /too many (clients|connections)/i.test(error.message)
}

/**
 * A refused state or a caller's mistake → 400 with its message, so the CLI exits non-zero naming it. An exhausted
 * connection limit → 503 (the CLI retries it with the request's idempotency key). Anything else is logged here with
 * the operation and its stack, then answered as the opaque 500: the access log line carries only the message.
 */
const answer =
  <I, O>(name: Name, work: (input: I) => Promise<O>) =>
  async ({ input }: { input: I }): Promise<O> => {
    try {
      return await work(input)
    } catch (error) {
      if (error instanceof ReviewError) throw new ORPCError('BAD_REQUEST', { message: error.message })
      if (isConnectionExhausted(error)) {
        throw new ORPCError('SERVICE_UNAVAILABLE', {
          message: `review ${name}: the database role is at its connection limit; retry in a few seconds`,
          cause: error,
        })
      }
      console.error(`[agw-host] review ${name} failed`, error)
      throw error
    }
  }

type Name = 'prepare' | 'cancel' | 'submit' | 'dispose' | 'status' | 'route' | 'covered' | 'stats'
const OPERATION_IDS = {
  prepare: 'reviewPrepare',
  cancel: 'reviewCancel',
  submit: 'reviewSubmit',
  dispose: 'reviewDispose',
  status: 'reviewStatus',
  route: 'reviewRoute',
  covered: 'reviewCovered',
  stats: 'reviewStats',
} as const satisfies Record<Name, string>

export function reviewOperations(service: ReviewService): Record<(typeof OPERATION_IDS)[Name], HostOperation> {
  const op = <I extends z.ZodType, O extends z.ZodType>(
    name: Name,
    spec: { summary: string; description?: string; cli?: Partial<ResolvedCliSpec>; input: I; output: O },
    work: (input: z.output<I>) => Promise<z.input<O>>,
  ): HostOperation => {
    const cli = cliOf(name, spec.cli)
    const path = `/review/${name}` as const
    const operationId = OPERATION_IDS[name]
    return {
      operationId,
      method: 'POST',
      path,
      cli,
      procedure: base
        .route({
          method: 'POST',
          path,
          operationId,
          summary: spec.summary,
          ...(spec.description ? { description: spec.description } : {}),
          tags: ['review'],
          spec: withCli(cli),
        })
        .input(spec.input)
        .output(spec.output)
        // the zod types are checked at each call of `op`; oRPC's generic inference does not see through this helper
        .handler(answer(name, work) as never),
    }
  }

  return {
    reviewPrepare: op(
      'prepare',
      {
        summary:
          'Prepare one review job: route the change, record the account quota reading, write the job dir the reviewer agent reads',
        description:
          'status ready: run the reviewer agent with `prompt` (also in the file `promptFile`) on `seat`, then `agw review submit`; a repeat prepare of the same thread, head tree and tier returns the same prepared job (`reused`). skipped: tier none. held: the deep cap only (wait, never downgrade); the account quota is recorded, not judged. needs-human: three rounds in a row on the thread ended with an important finding (a clean round resets the count).',
        cli: { mutating: true },
        input: PrepareInput,
        output: PrepareOutput,
      },
      (input) => service.prepare(input),
    ),
    reviewCancel: op(
      'cancel',
      {
        summary: 'Abandon a prepared review job and remove its tree',
        description: 'Only a prepared job (cancelled); a submitted or abandoned one is refused.',
        cli: { mutating: true, positional: ['jobId'] },
        input: CancelInput,
        output: CancelOutput,
      },
      (input) => service.cancel(input),
    ),
    reviewSubmit: op(
      'submit',
      {
        summary: "Submit the reviewer agent's JSON reply (stdin); prints REVIEW_OUTPUT v4",
        description:
          'Idempotent per (job, attempt). Refused for an abandoned job, another attempt of a submitted one, or a files list with a path that is not in stat.txt (nothing is written: re-ask the agent). A list that leaves stat.txt paths out is accepted: they are recorded as `unreviewed`, `covered` does not count them, the next prepare on the thread reads them. A list that echoes none of them is refused.',
        cli: { mutating: true, positional: ['jobId'], stdin: 'reply' },
        input: SubmitInput,
        output: ReviewOutputV4,
      },
      (input) => service.submit(input),
    ),
    reviewDispose: op(
      'dispose',
      {
        summary: 'Answer findings: fixed, wrong, intentional, irrelevant, or open again',
        description:
          "One id: that finding. `<id1>,<id2>` (comma-separated): all of them or, when an id is not in the job's thread, none; prints `{disposed}`. `--all-open <disposition>` (no ids): every open finding of the job's thread.",
        cli: { mutating: true, positional: ['jobId', 'findingId', 'disposition'] },
        input: DisposeInput,
        output: DisposeOutput,
      },
      (input) => service.dispose(input),
    ),
    reviewStatus: op(
      'status',
      {
        summary: 'A job and its thread findings, or the newest jobs of the repo at --cwd',
        cli: { positional: ['jobId'] },
        input: StatusInput,
        output: StatusOutput,
      },
      (input) => service.status(input),
    ),
    reviewRoute: op(
      'route',
      {
        summary: 'The review router alone: the tier a base..head range needs (no ledger, no LLM)',
        input: RouteInput,
        output: RouteOutput,
      },
      (input) => service.route(input),
    ),
    reviewCovered: op(
      'covered',
      {
        summary: 'Whether every first-parent commit of a range sits under a submitted review at its required tier',
        description: 'Exit 0 either way: read `covered`.',
        input: CoveredInput,
        output: CoveredOutput,
      },
      (input) => service.covered(input),
    ),
    reviewStats: op(
      'stats',
      {
        summary: 'Quality numbers of the review ledger: jobs, wall time, findings, dispositions, precision, anchoring',
        description:
          'Read-only and deterministic (no LLM). Grouped by tier (default), normalized routing rule, reviewer prompt fingerprint or repo; --since and --repo narrow it; --bucket week splits the result into ISO weeks (Monday 00:00 UTC, by the creation of the job). Probe repos (agw-verify, agw-eval-recall) are left out.',
        input: StatsInput,
        output: StatsOutput,
      },
      (input) => service.stats(input),
    ),
  }
}
