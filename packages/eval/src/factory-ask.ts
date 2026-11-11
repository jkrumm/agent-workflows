import { join } from 'node:path'
import { z } from 'zod'
import { wilson } from './gt-stats.ts'

// The eval of the factory's Judge (`factory-ask`, route `factory.ask`): is the Decision the owner's, or can the plan, the
// facts or the declared default answer it? Cases are real Decisions of the factory's database, scrubbed (README §Judge
// eval); the reference is the answer that held, never the Judge's own. Pure: the host's scorer wraps it, no model here.

/** The cases, committed: every one is scrubbed of private names, hosts and ids (the repo is public). */
export const FACTORY_ASK_CASES_PATH = join(import.meta.dir, '..', 'factory-ask', 'cases.jsonl')

/** Bump on any change to what a score means: compare refuses to mix scorer versions silently. */
export const FACTORY_ASK_SCORER_VERSION = '2026-11-11.1'

/** Where the label comes from: what makes the reference the answer that held. */
export const FactoryAskBasis = z.enum([
  /** The owner answered the Decision (or the sibling Decision of the same cause) and said what held. */
  'owner-answer',
  /** The owner never answered; the Issue's outcome showed which option ran and stood. */
  'issue-outcome',
  /** The default was taken after the wait and the factory acted on it; nothing contradicted it. */
  'default-taken',
  /** Open or unanswered at the time of writing: the class of the question labels it (taste, spend, security, ...). */
  'class',
  /** Written for the set: a real shape with the facts changed so that one answer is decided. */
  'synthetic',
])
export type FactoryAskBasis = z.output<typeof FactoryAskBasis>

/**
 * What the Judge should have done with one Decision.
 * - `owner`: only the owner can answer it; any `answer` verdict fails.
 * - `answer`: the facts, the plan or the default settle it; an `owner` verdict is an over-escalation. `answer` names the
 *   option that held (absent: any option counts, the case only tests restraint).
 * - `either`: the owner answered it, but with the do-nothing default the lead had declared, so taking that default was
 *   legitimate too. Passes on `owner` or on `answer`; only the constraints below can fail it.
 */
export const FactoryAskReference = z
  .object({
    verdict: z.enum(['owner', 'answer', 'either']),
    /** The option label that held (`answer`), or the one `either` accepts besides `owner`. */
    answer: z.string().min(1).optional(),
    /** Options nothing could apply: a verdict that picks one is the retro's failure, wherever else it is right. */
    inapplicable: z.array(z.string().min(1)).optional(),
    /** The facts rule the declared default out: a verdict that picks the default is a fall back. */
    defaultContradicted: z.boolean().optional(),
    basis: FactoryAskBasis,
    note: z.string().min(1).max(400),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (r.verdict === 'either' && !r.answer)
      ctx.addIssue({ code: 'custom', message: 'an either case names the answer it accepts' })
    if (r.verdict === 'owner' && r.answer) ctx.addIssue({ code: 'custom', message: 'an owner case has no answer' })
  })
export type FactoryAskReference = z.output<typeof FactoryAskReference>

/** The Judge's verdict as the case scorer reads it (the workflow's output, held to its guards). */
export interface AskVerdict {
  verdict: 'answer' | 'owner'
  answer: string
}

export interface AskScore {
  scores: Record<string, number>
  pass: boolean
  feedback?: string
}

/** The metrics a case can carry; a case scores only those that apply to it. */
export const ASK_METRICS = [
  'ownerKept',
  'noInapplicable',
  'factsOverDefault',
  'answered',
  'answerHeld',
  'eitherOk',
] as const
export type AskMetric = (typeof ASK_METRICS)[number]

/** The three the Issue names, in order, and the guards that keep an always-owner Judge from passing them. */
export const GATE_METRICS: readonly AskMetric[] = ['ownerKept', 'noInapplicable', 'factsOverDefault']
export const GUARD_METRICS: readonly AskMetric[] = ['answered', 'answerHeld', 'eitherOk']

/**
 * Scores one verdict against one case. Every score is 0 or 1 and present only where it applies, so a mean is over the
 * cases it concerns.
 * - `ownerKept` (reference `owner`): the verdict is `owner`. What only the owner can answer reaches him.
 * - `noInapplicable` (reference lists `inapplicable`): the verdict does not pick one of them.
 * - `factsOverDefault` (`defaultContradicted`): the verdict does not pick the declared default.
 * - `answered` (reference `answer`): the verdict is not `owner`, no over-escalation.
 * - `answerHeld` (reference `answer` with a named option): the verdict picks exactly that option.
 * - `eitherOk` (reference `either`): `owner`, or the named answer.
 * A verdict that is not valid (the run failed, the output did not parse) scores 0 on everything that applies and `valid` 0.
 * `pass`: every applicable score is 1.
 */
export function scoreFactoryAsk(
  got: AskVerdict | null,
  ref: FactoryAskReference,
  declaredDefault: string | null,
): AskScore {
  const picked = got?.verdict === 'answer' ? got.answer : null
  const applicable: Partial<Record<AskMetric, boolean>> = {
    ...(ref.verdict === 'owner' ? { ownerKept: got?.verdict === 'owner' } : {}),
    ...(ref.inapplicable?.length
      ? { noInapplicable: picked === null ? got !== null : !ref.inapplicable.includes(picked) }
      : {}),
    ...(ref.defaultContradicted
      ? { factsOverDefault: got !== null && !(picked !== null && picked === declaredDefault) }
      : {}),
    ...(ref.verdict === 'answer' ? { answered: got?.verdict === 'answer' } : {}),
    ...(ref.verdict === 'answer' && ref.answer ? { answerHeld: picked === ref.answer } : {}),
    ...(ref.verdict === 'either'
      ? { eitherOk: got?.verdict === 'owner' || (picked !== null && picked === ref.answer) }
      : {}),
  }
  const scores: Record<string, number> = { valid: got ? 1 : 0 }
  for (const [metric, ok] of Object.entries(applicable)) scores[metric] = ok ? 1 : 0
  const failed = Object.entries(applicable)
    .filter(([, ok]) => !ok)
    .map(([m]) => m)
  const said = got ? (got.verdict === 'owner' ? 'owner' : `answer "${got.answer}"`) : 'no verdict'
  return {
    scores,
    pass: got !== null && failed.length === 0,
    ...(got === null || failed.length
      ? { feedback: `${said}: ${got === null ? 'invalid' : failed.join(', ')} failed` }
      : {}),
  }
}

export interface MetricRate {
  metric: string
  n: number
  passed: number
  /** Wilson 95 % interval of the rate: a 33-case set cannot tell two routes a few points apart. */
  rate: number | null
  lo: number | null
  hi: number | null
}

/** Per metric over the cases it applies to: how many, how many passed, the rate and its Wilson interval. */
export function summarizeFactoryAsk(results: readonly { scores: Record<string, number> }[]): MetricRate[] {
  return ['valid', ...ASK_METRICS].map((metric) => {
    const seen = results.filter((r) => metric in r.scores)
    const passed = seen.filter((r) => r.scores[metric] === 1).length
    const w = wilson(passed, seen.length)
    return { metric, n: seen.length, passed, rate: w?.p ?? null, lo: w?.lo ?? null, hi: w?.hi ?? null }
  })
}
