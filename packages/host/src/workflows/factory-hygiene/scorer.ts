import type { Scorer, Verdict } from '@agent-workflows/runtime'
import { z } from 'zod'
import { FactoryHygieneOutput, type FactoryHygieneOutputValue } from './schema.ts'

/** Bump on any change to what a score means: compare refuses to mix scorer versions silently. */
const FACTORY_HYGIENE_SCORER_VERSION = '2026-11-16.1'

/** A line of the fixture checkout and a distinctive substring of it (the test proves the line holds the text). */
const spot = z.object({ path: z.string().min(1), line: z.number().int().min(1), text: z.string().min(1) })

/** A planted defect: a stale doc line against the code line that contradicts it, or a filler line with a phrase to quote. */
const plant = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('stale'), path: z.string().min(1), claim: spot, code: spot }),
  z.object({ kind: z.literal('slop'), path: z.string().min(1), claim: spot, quote: z.string().min(1) }),
])

/** A case's expected answer: the plants a finding must name, and the clean candidates that must get no finding at all. */
export const FactoryHygieneReference = z.object({
  plants: z.array(plant),
  clean: z.array(z.string().min(1)),
})
export type FactoryHygieneReference = z.output<typeof FactoryHygieneReference>
type Plant = FactoryHygieneReference['plants'][number]

const ZERO = { valid: 0, recall: 0, anchored: 0, precision: 0, cleanKept: 0 }
const LINE_SLACK = 2

const share = (part: number, whole: number) => (whole === 0 ? 1 : part / whole)
const normalize = (path: string) => path.replace(/^\.\//, '')

/** Every `path:line` (or `path:from-to`) token of a text. */
function locations(text: string): { path: string; from: number; to: number }[] {
  return [...text.matchAll(/([\w@.\-/]+\.\w+):(\d+)(?:\s*[-–]\s*(\d+))?/g)].map((m) => {
    const from = Number(m[2])
    return { path: normalize(m[1] ?? ''), from, to: Math.max(from, Number(m[3] ?? from)) }
  })
}

const names = (evidence: string, at: { path: string; line: number }) =>
  locations(evidence).some((l) => l.path === at.path && at.line >= l.from - LINE_SLACK && at.line <= l.to + LINE_SLACK)

/** Stale: the claim and the code both named as `path:line` within two lines. Slop: the planted phrase quoted. */
const anchoredOn = (plant: Plant, evidence: string) =>
  plant.kind === 'stale'
    ? names(evidence, plant.claim) && names(evidence, plant.code)
    : evidence.toLowerCase().includes(plant.quote.toLowerCase())

/**
 * The `factory-hygiene` scorer. Deterministic, no model. Every score is a share from 0 to 1:
 * - `valid`: the output parses as the answer; when it is 0 (or the run failed) so is every other score;
 * - `recall`: the share of plants with a finding of the same kind and path; 1 without plants;
 * - `anchored`: of the plants found, the share whose evidence is as good as the factory needs: a stale finding names the
 *   claim and the contradicting code as `path:line` (within two lines), a slop finding quotes the planted phrase; 1
 *   without plants, 0 when plants exist and none was found;
 * - `precision`: the share of findings on a planted kind and path; 1 without findings;
 * - `cleanKept`: the share of clean candidates with no finding of any kind; 1 without clean candidates.
 * `pass`: valid, recall, precision and cleanKept all 1 (`anchored` is reported, not gated). A miss and a false positive
 * are named by path in the feedback.
 */
export const factoryHygieneScorer: Scorer<unknown, FactoryHygieneReference> = {
  version: FACTORY_HYGIENE_SCORER_VERSION,
  reference: FactoryHygieneReference,
  score(_input, output, ctx): Verdict {
    const parsed = FactoryHygieneOutput.safeParse(output)
    if (!parsed.success) {
      const feedback = output === null ? 'the run failed' : 'the output is not a hygiene answer'
      return { scores: { ...ZERO }, pass: false, feedback }
    }
    const want = ctx.reference
    if (!want) return { scores: { valid: 1 }, pass: true }

    const findings: FactoryHygieneOutputValue['findings'] = parsed.data.findings
    const found = want.plants.map((p) => findings.find((f) => f.kind === p.kind && f.path === p.path))
    const missed = want.plants.filter((_, i) => found[i] === undefined)
    const foundCount = want.plants.length - missed.length
    const anchoredCount = want.plants.filter((p, i) => {
      const f = found[i]
      return f !== undefined && anchoredOn(p, f.evidence)
    }).length
    const onPlant = findings.filter((f) => want.plants.some((p) => p.kind === f.kind && p.path === f.path))
    const spurious = findings.filter((f) => !onPlant.includes(f))
    const flagged = want.clean.filter((path) => findings.some((f) => f.path === path))

    const scores = {
      valid: 1,
      recall: share(foundCount, want.plants.length),
      anchored: want.plants.length === 0 ? 1 : foundCount === 0 ? 0 : anchoredCount / foundCount,
      precision: share(onPlant.length, findings.length),
      cleanKept: share(want.clean.length - flagged.length, want.clean.length),
    }
    const feedback = [
      missed.length > 0 ? `missed: ${missed.map((p) => `${p.kind} ${p.path}`).join(', ')}` : '',
      flagged.length > 0 ? `false positive on a clean candidate: ${flagged.join(', ')}` : '',
      spurious.length > 0 ? `finding off the plants: ${spurious.map((f) => `${f.kind} ${f.path}`).join(', ')}` : '',
    ].filter((line) => line !== '')
    return {
      scores,
      pass: scores.recall === 1 && scores.precision === 1 && scores.cleanKept === 1,
      ...(feedback.length === 0 ? {} : { feedback: feedback.join('; ') }),
    }
  },
}
