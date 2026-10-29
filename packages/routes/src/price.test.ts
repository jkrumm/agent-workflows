import { describe, expect, test } from 'bun:test'
import { applyPatch } from './overrides.ts'
import { costFromUsage } from './cost.ts'
import { type Price, priceCall, priceSchema } from './price.ts'
import { DEFAULT_ROUTES, resolveRoute } from './index.ts'
import { routeSchema } from './schema.ts'

const tokens = { kind: 'image-tokens', textInPerM: 5, imageInPerM: 8, outputPerM: 30 } as const

describe('priceCall', () => {
  test('image tokens: text, image input and output at their own rates', () => {
    const usage = {
      input_tokens: 150,
      output_tokens: 1_000,
      input_tokens_details: { text_tokens: 50, image_tokens: 100 },
    }
    expect(priceCall(tokens, usage)).toEqual({ usd: (50 * 5 + 100 * 8 + 1_000 * 30) / 1e6, source: 'rate' })
  })

  test('without the text/image split the whole input is text', () => {
    expect(priceCall(tokens, { input_tokens: 100, output_tokens: 10 })).toEqual({
      usd: (100 * 5 + 10 * 30) / 1e6,
      source: 'rate',
    })
  })

  test('a side of the input split the endpoint did not report is the remainder of the input', () => {
    const onlyText = { input_tokens: 150, output_tokens: 0, input_tokens_details: { text_tokens: 50 } }
    expect(priceCall(tokens, onlyText)).toEqual({ usd: (50 * 5 + 100 * 8) / 1e6, source: 'rate' })
    const onlyImage = { input_tokens: 150, output_tokens: 0, input_tokens_details: { image_tokens: 100 } }
    expect(priceCall(tokens, onlyImage)).toEqual({ usd: (50 * 5 + 100 * 8) / 1e6, source: 'rate' })
  })

  test('a split that does not add up to the input is unknown, never an under-price', () => {
    const over = { input_tokens: 10, output_tokens: 0, input_tokens_details: { image_tokens: 99 } }
    expect(priceCall(tokens, over)).toEqual({ usd: null, source: 'unknown' })
    const mismatch = {
      input_tokens: 150,
      output_tokens: 0,
      input_tokens_details: { text_tokens: 50, image_tokens: 50 },
    }
    expect(priceCall(tokens, mismatch)).toEqual({ usd: null, source: 'unknown' })
    const textOver = { input_tokens: 10, output_tokens: 0, input_tokens_details: { text_tokens: 11 } }
    expect(priceCall(tokens, textOver)).toEqual({ usd: null, source: 'unknown' })
  })

  test('the provider cost wins, even over a flat price', () => {
    expect(priceCall(tokens, { cost: 0.5, input_tokens: 1, output_tokens: 1 })).toEqual({
      usd: 0.5,
      source: 'provider',
    })
    expect(priceCall({ kind: 'unit', unit: 'call', usd: 0.01 }, { cost: 0.02 })).toEqual({
      usd: 0.02,
      source: 'provider',
    })
  })

  test('a flat price needs no usage', () => {
    expect(priceCall({ kind: 'unit', unit: 'call', usd: 0.018 }, null)).toEqual({ usd: 0.018, source: 'rate' })
  })

  test('missing usage, missing counts or no price is unknown, never 0', () => {
    expect(priceCall(tokens, null)).toEqual({ usd: null, source: 'unknown' })
    expect(priceCall(tokens, { input_tokens: 5 })).toEqual({ usd: null, source: 'unknown' })
    expect(priceCall(undefined, { input_tokens: 5, output_tokens: 5 })).toEqual({ usd: null, source: 'unknown' })
    expect(priceCall(tokens, { cost: -1, input_tokens: Number.NaN, output_tokens: 1 })).toEqual({
      usd: null,
      source: 'unknown',
    })
  })
})

const IMAGE_ROUTES = Object.fromEntries(
  Object.entries(DEFAULT_ROUTES).filter(([id]) => id.startsWith('image.')),
) as Record<
  'image.flare' | 'image.sunburst' | 'image.cutout.recraft' | 'image.cutout.bria' | 'image.enhance',
  (typeof DEFAULT_ROUTES)[keyof typeof DEFAULT_ROUTES]
>

describe('the image routes', () => {
  test('every seat is a valid route entry with a price', () => {
    for (const [id, entry] of Object.entries(IMAGE_ROUTES)) {
      expect(routeSchema.safeParse(entry).success, id).toBe(true)
      const price = (entry as { price?: unknown }).price
      // the planner is a text model: priced by `rate`, not by `price`
      if (id === 'image.enhance') expect(price).toBeUndefined()
      else expect(priceSchema.safeParse(price).success, id).toBe(true)
    }
  })

  test('both generation models bill alike; the cutout models bill per call', () => {
    expect(IMAGE_ROUTES['image.flare'].price).toEqual(IMAGE_ROUTES['image.sunburst'].price)
    expect(IMAGE_ROUTES['image.cutout.recraft'].price).toEqual({ kind: 'unit', unit: 'call', usd: 0.01 })
    expect(IMAGE_ROUTES['image.cutout.bria'].price).toEqual({ kind: 'unit', unit: 'call', usd: 0.018 })
  })

  test('a resolved route is a copy, and AGW_ROUTES overrides it like any route', () => {
    const route = resolveRoute('image.flare', {})
    expect(route.id).toBe('image.flare')
    route.model = 'changed'
    expect(IMAGE_ROUTES['image.flare'].model).not.toBe('changed')
    const patched = resolveRoute('image.cutout.recraft', {
      AGW_ROUTES: JSON.stringify({ 'image.cutout.recraft': { price: { kind: 'unit', unit: 'call', usd: 0.5 } } }),
    })
    expect(patched.price).toEqual({ kind: 'unit', unit: 'call', usd: 0.5 })
  })

  test('an override that changes the model drops the price (a stale price would price the new model wrongly), one that names a price keeps it', () => {
    const base = IMAGE_ROUTES['image.cutout.recraft']
    expect(applyPatch('image.cutout.recraft', base, { model: 'other/model' }).price).toBeUndefined()
    expect(
      applyPatch('image.cutout.recraft', base, {
        model: 'other/model',
        price: { kind: 'unit', unit: 'call', usd: 0.5 },
      }).price,
    ).toEqual({ kind: 'unit', unit: 'call', usd: 0.5 })
    expect(
      applyPatch('image.cutout.recraft', base, { price: { kind: 'unit', unit: 'call', usd: 0.02 } }).price,
    ).toEqual({
      kind: 'unit',
      unit: 'call',
      usd: 0.02,
    })
  })
})

describe('unit prices', () => {
  const tts: Price = { kind: 'unit', unit: 'character', usd: 0.18, per: 1000 }
  const image: Price = {
    kind: 'unit',
    unit: 'image',
    usd: 0.05,
    tiers: [
      { match: { quality: 'low' }, usd: 0.006 },
      { match: { quality: 'high', size: '1024x1024' }, usd: 0.053 },
    ],
  }

  test('per 1k: a price per thousand characters scales by the count', () => {
    expect(priceCall(tts, { units: { quantity: 2_500 } })).toEqual({ usd: (0.18 * 2_500) / 1000, source: 'rate' })
  })

  test('per second and per image count the quantity', () => {
    expect(priceCall({ kind: 'unit', unit: 'second', usd: 0.0001 }, { units: { quantity: 90 } })).toEqual({
      usd: 0.0001 * 90,
      source: 'rate',
    })
    expect(priceCall({ kind: 'unit', unit: 'image', usd: 0.04 }, { units: { quantity: 3 } })).toEqual({
      usd: 0.04 * 3,
      source: 'rate',
    })
  })

  test('tiers: the first match wins, every key must match, no match falls back to the base price', () => {
    expect(priceCall(image, { units: { quantity: 2, attributes: { quality: 'low', size: '1536x1024' } } }).usd).toBe(
      0.012,
    )
    expect(priceCall(image, { units: { quantity: 1, attributes: { quality: 'high', size: '1024x1024' } } }).usd).toBe(
      0.053,
    )
    expect(priceCall(image, { units: { quantity: 1, attributes: { quality: 'high', size: '1536x1024' } } }).usd).toBe(
      0.05,
    )
    expect(priceCall(image, { units: { quantity: 1 } }).usd).toBe(0.05)
  })

  test('a unit price needs its quantity, except a call, which is one', () => {
    expect(priceCall(tts, null)).toEqual({ usd: null, source: 'unknown' })
    expect(priceCall(tts, { units: { quantity: -1 } })).toEqual({ usd: null, source: 'unknown' })
    expect(priceCall({ kind: 'unit', unit: 'call', usd: 0.01 }, null)).toEqual({ usd: 0.01, source: 'rate' })
    expect(priceCall({ kind: 'unit', unit: 'call', usd: 0.01 }, { units: { quantity: 3 } })).toEqual({
      usd: 0.03,
      source: 'rate',
    })
  })

  test('the schema accepts the shapes and refuses a bad unit, a zero per, an empty tier list', () => {
    expect(priceSchema.safeParse(tts).success).toBe(true)
    expect(priceSchema.safeParse(image).success).toBe(true)
    expect(priceSchema.safeParse({ ...tts, unit: 'parsec' }).success).toBe(false)
    expect(priceSchema.safeParse({ ...tts, per: 0 }).success).toBe(false)
    expect(priceSchema.safeParse({ ...tts, tiers: [] }).success).toBe(false)
    expect(priceSchema.safeParse({ ...tts, extra: 1 }).success).toBe(false)
  })

  test('costFromUsage prices a route with a price by it, the provider cost still first', () => {
    expect(costFromUsage('iu-openai', { units: { quantity: 1_000 } }, undefined, tts)).toEqual({
      usd: 0.18,
      source: 'rate',
    })
    expect(costFromUsage('iu-openai', { cost: 0.5, units: { quantity: 1_000 } }, undefined, tts)).toEqual({
      usd: 0.5,
      source: 'provider',
    })
    expect(costFromUsage('iu-openai', null, undefined, tts)).toEqual({ usd: null, source: 'unknown' })
    // a route without a price is the text-token path, unchanged
    expect(
      costFromUsage('iu-openai', { prompt_tokens: 50_000, completion_tokens: 0 }, { inputPerM: 2, outputPerM: 1 }),
    ).toEqual({ usd: 0.1, source: 'rate' })
  })
})
