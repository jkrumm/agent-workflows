import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import {
  FACTORY_ASK_CASES_PATH,
  FactoryAskReference,
  PlainCase,
  readCases,
  scoreFactoryAsk,
  summarizeFactoryAsk,
} from '../src/index.ts'

const cases = readCases(FACTORY_ASK_CASES_PATH, PlainCase)
const ref = (over: Partial<FactoryAskReference> & Pick<FactoryAskReference, 'verdict'>) =>
  FactoryAskReference.parse({ basis: 'synthetic', note: 'n', ...over })
const owner = { verdict: 'owner', answer: '' } as const
const pick = (answer: string) => ({ verdict: 'answer', answer }) as const

describe('factory-ask cases', () => {
  test('ids are unique and every reference parses', () => {
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length)
    for (const c of cases) expect(FactoryAskReference.safeParse(c.reference).success, c.id).toBe(true)
  })

  test('every reference names options the case offers, and a contradicted default is a declared one', () => {
    for (const c of cases) {
      const ask = z
        .object({
          options: z.array(z.object({ label: z.string() })),
          noAnswer: z.object({ default: z.string().nullable() }),
        })
        .parse((c.input as { ask: unknown }).ask)
      const labels = ask.options.map((o) => o.label)
      const r = FactoryAskReference.parse(c.reference)
      for (const named of [...(r.answer ? [r.answer] : []), ...(r.inapplicable ?? [])])
        expect(labels, c.id).toContain(named)
      if (r.defaultContradicted) expect(ask.noAnswer.default, c.id).not.toBeNull()
    }
  })

  test('the set covers each thing the Judge is measured on, with enough cases to read', () => {
    const refs = cases.map((c) => FactoryAskReference.parse(c.reference))
    expect(refs.filter((r) => r.verdict === 'owner').length).toBeGreaterThanOrEqual(10)
    expect(refs.filter((r) => r.verdict === 'answer').length).toBeGreaterThanOrEqual(10)
    expect(refs.filter((r) => r.inapplicable?.length).length).toBeGreaterThanOrEqual(5)
    expect(refs.filter((r) => r.defaultContradicted).length).toBeGreaterThanOrEqual(4)
  })

  test('the cases carry no private marker', () => {
    const text = JSON.stringify(cases)
    expect(text).not.toMatch(/\/Users\/|\.ts\.net|IU-Group|jkrumm|\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/)
  })
})

describe('scoreFactoryAsk', () => {
  test('owner: only an owner verdict keeps it', () => {
    const r = ref({ verdict: 'owner' })
    expect(scoreFactoryAsk(owner, r, null)).toEqual({ scores: { valid: 1, ownerKept: 1 }, pass: true })
    const wrong = scoreFactoryAsk(pick('A'), r, null)
    expect(wrong.scores).toEqual({ valid: 1, ownerKept: 0 })
    expect(wrong.pass).toBe(false)
  })

  test('an inapplicable option fails even where the owner would take it, an owner verdict passes', () => {
    const r = ref({ verdict: 'owner', inapplicable: ['Disable the Watch'] })
    expect(scoreFactoryAsk(pick('Disable the Watch'), r, null).scores).toMatchObject({
      ownerKept: 0,
      noInapplicable: 0,
    })
    expect(scoreFactoryAsk(owner, r, null).scores).toMatchObject({ ownerKept: 1, noInapplicable: 1 })
  })

  test('facts over default: picking the declared default fails, the facts answer and an owner verdict do not', () => {
    const r = ref({ verdict: 'answer', answer: 'B', defaultContradicted: true })
    expect(scoreFactoryAsk(pick('A'), r, 'A').scores).toEqual({
      valid: 1,
      factsOverDefault: 0,
      answered: 1,
      answerHeld: 0,
    })
    expect(scoreFactoryAsk(pick('B'), r, 'A')).toEqual({
      scores: { valid: 1, factsOverDefault: 1, answered: 1, answerHeld: 1 },
      pass: true,
    })
    expect(scoreFactoryAsk(owner, r, 'A').scores).toEqual({ valid: 1, factsOverDefault: 1, answered: 0, answerHeld: 0 })
  })

  test('answer without a named option only tests restraint', () => {
    const r = ref({ verdict: 'answer' })
    expect(scoreFactoryAsk(pick('anything'), r, null).pass).toBe(true)
    expect(scoreFactoryAsk(owner, r, null).scores).toEqual({ valid: 1, answered: 0 })
  })

  test('either passes on owner and on the named answer only', () => {
    const r = ref({ verdict: 'either', answer: 'Leave open' })
    expect(scoreFactoryAsk(owner, r, null).pass).toBe(true)
    expect(scoreFactoryAsk(pick('Leave open'), r, null).pass).toBe(true)
    expect(scoreFactoryAsk(pick('Merge'), r, null).pass).toBe(false)
  })

  test('no verdict scores 0 on everything that applies', () => {
    const r = ref({ verdict: 'owner', inapplicable: ['X'], defaultContradicted: true })
    const s = scoreFactoryAsk(null, r, 'X')
    expect(s.scores).toEqual({ valid: 0, ownerKept: 0, noInapplicable: 0, factsOverDefault: 0 })
    expect(s.pass).toBe(false)
  })

  test('the reference refuses an either without an answer and an owner with one', () => {
    expect(FactoryAskReference.safeParse({ verdict: 'either', basis: 'class', note: 'n' }).success).toBe(false)
    expect(FactoryAskReference.safeParse({ verdict: 'owner', answer: 'x', basis: 'class', note: 'n' }).success).toBe(
      false,
    )
  })

  test('an always-owner Judge passes the owner gate and fails the guard on answer cases', () => {
    const results = cases.map((c) => scoreFactoryAsk(owner, FactoryAskReference.parse(c.reference), null))
    const rates = Object.fromEntries(summarizeFactoryAsk(results).map((m) => [m.metric, m.rate]))
    expect(rates.ownerKept).toBe(1)
    expect(rates.answered).toBe(0)
  })

  test('summarize: n, passes and a Wilson interval per metric, null where nothing applies', () => {
    const rows = summarizeFactoryAsk([{ scores: { valid: 1, ownerKept: 1 } }, { scores: { valid: 1, ownerKept: 0 } }])
    const owned = rows.find((m) => m.metric === 'ownerKept')
    expect(owned).toMatchObject({ n: 2, passed: 1, rate: 0.5 })
    expect(owned?.lo).toBeLessThan(0.5)
    expect(owned?.hi).toBeGreaterThan(0.5)
    expect(rows.find((m) => m.metric === 'answered')).toMatchObject({ n: 0, rate: null })
  })
})
