import { FACTORY_ASK_SCORER_VERSION, FactoryAskReference, scoreFactoryAsk } from '@agent-workflows/eval'
import type { Scorer, Verdict } from '@agent-workflows/runtime'
import { FactoryAskOutput } from './schema.ts'

/** The declared default of either input shape: the Decision's `noAnswer.default`, today's ask's `default`. */
const declaredDefault = (input: unknown): string | null => {
  const ask = (input as { ask?: { default?: unknown; noAnswer?: { default?: unknown } } } | null)?.ask
  const value = ask?.noAnswer?.default ?? ask?.default
  return typeof value === 'string' ? value : null
}

/**
 * The `factory-ask` scorer (concept §6). Deterministic, no model: the three things the Judge is measured on, owner kept,
 * no option nothing can apply, no fall back to the default when the facts decide, plus the guards against a Judge that
 * escalates everything. The version bumps with any change to what a score means (`packages/eval/src/factory-ask.ts`). A run without a reference (drift) scores `valid` only.
 */
export const factoryAskScorer: Scorer<unknown, FactoryAskReference> = {
  version: FACTORY_ASK_SCORER_VERSION,
  reference: FactoryAskReference,
  score(input, output, ctx): Verdict {
    const parsed = FactoryAskOutput.safeParse(output)
    const got = parsed.success ? { verdict: parsed.data.verdict, answer: parsed.data.answer } : null
    const want = ctx.reference
    if (!want) return { scores: { valid: got ? 1 : 0 }, pass: got !== null }
    return scoreFactoryAsk(got, want, declaredDefault(input))
  },
}
