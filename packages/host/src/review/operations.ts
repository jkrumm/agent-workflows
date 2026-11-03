// `agw review prepare|request|cancel|submit|dispose|status|route|covered`: host operations like the fleet's, no journal run.
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
  FindingRecord,
  PrepareInput,
  PrepareOutput,
  RequestInput,
  RequestOutput,
  ReviewError,
  ReviewOutputV4,
  RouteInput,
  RouteOutput,
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

/** A refused state or a caller's mistake → 400 with its message, so the CLI exits non-zero naming it. */
const answer =
  <I, O>(work: (input: I) => Promise<O>) =>
  async ({ input }: { input: I }): Promise<O> => {
    try {
      return await work(input)
    } catch (error) {
      if (error instanceof ReviewError) throw new ORPCError('BAD_REQUEST', { message: error.message })
      throw error
    }
  }

type Name = 'prepare' | 'request' | 'cancel' | 'submit' | 'dispose' | 'status' | 'route' | 'covered'
const OPERATION_IDS = {
  prepare: 'reviewPrepare',
  request: 'reviewRequest',
  cancel: 'reviewCancel',
  submit: 'reviewSubmit',
  dispose: 'reviewDispose',
  status: 'reviewStatus',
  route: 'reviewRoute',
  covered: 'reviewCovered',
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
        .handler(answer(work) as never),
    }
  }

  return {
    reviewPrepare: op(
      'prepare',
      {
        summary:
          'Prepare one review job: route the change, judge the ceiling, write the job dir the reviewer agent reads',
        description:
          'status ready: run the reviewer agent with `prompt` on `seat`, then `agw review submit`. skipped: tier none. held: the ceiling or the deep cap (wait, never downgrade). needs-human: three rounds on the thread.',
        cli: { mutating: true },
        input: PrepareInput,
        output: PrepareOutput,
      },
      (input) => service.prepare(input),
    ),
    reviewRequest: op(
      'request',
      {
        summary:
          'Prepare a job and have the software factory run the reviewer in a hidden session (no account to give)',
        description:
          'For callers that are not a Claude Code session, or are held by their own account. requested: the factory admits the session (ceiling and deep cap on the account it picks) and submits the reply itself; poll `agw review status <jobId>`. skipped: tier none. needs-human: three rounds. A failed spawn abandons the job and exits non-zero.',
        cli: { mutating: true },
        input: RequestInput,
        output: RequestOutput,
      },
      (input) => service.request(input),
    ),
    reviewCancel: op(
      'cancel',
      {
        summary: 'Cancel a hidden review the factory has not started (a held or queued spawn) and abandon its job',
        description:
          'Only a prepared job of the hidden transport. cancelled: the factory ended its spawn(s) before any session claimed them and the job is abandoned. running: a spawn is already claimed or started (factory not_cancellable); the job is kept and will submit. failed: the spawn is terminal (ended, failed or cancelled; the state is read from the 409 of the factory) and nothing will submit; the job is abandoned and its tree removed.',
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
          'Idempotent per (job, attempt). Refused for an abandoned job, another attempt of a submitted one, or a files list that differs from stat.txt (nothing is written: re-ask the agent).',
        cli: { mutating: true, positional: ['jobId'], stdin: 'reply' },
        input: SubmitInput,
        output: ReviewOutputV4,
      },
      (input) => service.submit(input),
    ),
    reviewDispose: op(
      'dispose',
      {
        summary: 'Answer one finding: fixed, wrong, intentional, irrelevant, or open again',
        cli: { mutating: true, positional: ['jobId', 'findingId', 'disposition'] },
        input: DisposeInput,
        output: FindingRecord,
      },
      (input) => service.dispose(input),
    ),
    reviewStatus: op(
      'status',
      {
        summary:
          "A job and its thread findings, or the newest jobs of the repo at --cwd. A prepared hidden job also shows `hidden`: the factory's spawns for it (read-only) and `gaveUp`, true when the retry a2 is terminal and nothing will submit; `agw review cancel` then abandons it",
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
  }
}
