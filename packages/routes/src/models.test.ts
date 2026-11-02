import { describe, expect, test } from 'bun:test'
import { canonicalModel, DEFAULT_ROUTES } from './index.ts'
import { TABLE_MODELS } from './models.ts'

const SONNET = 'claude-sonnet-5-5'
const HAIKU = 'claude-haiku-5-5'
const textModel = Object.values(DEFAULT_ROUTES).find((r) => r.wire === 'iu-openai')?.model as string

describe('canonicalModel', () => {
  test('a table model is itself, an owner/name id included', () => {
    expect([...TABLE_MODELS].some((m) => m.includes('/'))).toBe(true)
    for (const model of TABLE_MODELS) expect(canonicalModel(model)).toBe(model)
  })

  test.each([
    ['dot prefix (openai.)', `openai.${textModel}`, textModel],
    ['underscore provider with slash (vertex_ai_eu/)', `vertex_ai_eu/${textModel}`, textModel],
    ['slash prefix (deepseek/)', `deepseek/${textModel}`, textModel],
    ['a dated snapshot of a non-Claude id (-YYYY-MM-DD)', `${textModel}-2026-09-22`, textModel],
    ['a prefixed dated snapshot', `openai.${textModel}-2026-09-22`, textModel],
    ['a Claude snapshot', `${SONNET}-20261001`, SONNET],
    ['the [1m] flag', `${SONNET}[1m]`, SONNET],
    ['snapshot and [1m]', `${HAIKU}-20261001[1m]`, HAIKU],
    ['a prefixed snapshot', `vertex_ai_eu/${SONNET}-20261001`, SONNET],
    ['an alias', 'sonnet', SONNET],
    ['another alias', 'haiku', HAIKU],
  ])('%s', (_, raw, expected) => {
    expect(canonicalModel(raw)).toBe(expected)
  })

  test('an unknown id collapses onto nothing: owners stay apart, a date or prefix on an unknown is kept', () => {
    for (const raw of [
      'alice/custom-model',
      'bob/custom-model',
      'custom-model-2026-09-22',
      'alice/custom-model-2026-09-22',
      'openai.custom-model',
      `${textModel}-extra`,
      `alice/${textModel}-extra`,
    ])
      expect(canonicalModel(raw)).toBe(raw)
    expect(canonicalModel('alice/custom-model')).not.toBe(canonicalModel('bob/custom-model'))
  })

  test('an unknown id comes back unchanged, case included', () => {
    for (const raw of [
      'some-unknown-model',
      'Sonnet',
      'gpt-x-9.9-mini',
      'unknown-3.8-flash',
      'some-unknown-model-2026-13',
      'constructor',
    ])
      expect(canonicalModel(raw)).toBe(raw)
  })

  test('is idempotent', () => {
    for (const raw of [`openai.${textModel}`, `${SONNET}-20261001[1m]`, 'opus'])
      expect(canonicalModel(canonicalModel(raw))).toBe(canonicalModel(raw))
  })
})
