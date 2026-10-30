// The door's mirrored studio contract against fixtures written from the studio's own schemas: a drift on either side fails here.
import { describe, expect, test } from 'bun:test'
import { MAX_EDIT_IMAGE_BYTES, MAX_MASK_BYTES } from '@agent-workflows/capabilities'
import {
  EDIT_LIMITS,
  editRequestSchema,
  errorResponseSchema,
  generateRequestSchema,
  generateResponseSchema,
  IMAGE_MODELS,
  moderationErrorResponseSchema,
  planRequestSchema,
  planResponseSchema,
  streamEventSchema,
} from '../src/image-door/contract.ts'
import {
  completedFrame,
  completedResponse,
  editFields,
  errorBody,
  errorFrame,
  generateRequest,
  generateRequestLegacy,
  invalidGenerateRequests,
  invalidPlanRequests,
  moderationErrorBody,
  partialFrame,
  planRequest,
  planResponse,
} from './fixtures/image-door/studio.ts'

/** The schema accepts the fixture and hands it back unchanged (no default adds a key, no coercion changes a value). */
const roundTrips = (schema: { parse(data: unknown): unknown }, fixture: unknown) => {
  expect(schema.parse(fixture)).toEqual(fixture)
}

describe('requests', () => {
  test('a full generate request is accepted unchanged, the retired model id too, and defaults fill the rest', () => {
    roundTrips(generateRequestSchema, generateRequest)
    expect(generateRequestSchema.safeParse(generateRequestLegacy).success).toBe(true)
    expect(generateRequestSchema.parse({ prompt: 'x' })).toEqual({
      prompt: 'x',
      model: 'auto',
      size: 'auto',
      quality: 'auto',
      background: 'auto',
      output_format: 'png',
      n: 1,
      moderation: 'auto',
      partial_images: 0,
    })
  })

  test.each(invalidGenerateRequests)('generate refuses %s', (_reason, body) => {
    expect(generateRequestSchema.safeParse(body).success).toBe(false)
  })

  test('the edit fields are strings on the wire and are coerced', () => {
    expect(editRequestSchema.parse(editFields)).toMatchObject({
      output_compression: 90,
      n: 1,
      partial_images: 2,
      input_fidelity: 'high',
    })
    expect(editRequestSchema.safeParse({ ...editFields, n: '2' }).success).toBe(false) // streaming needs n=1
    expect(editRequestSchema.safeParse({ ...editFields, input_fidelity: 'max' }).success).toBe(false)
    expect(editRequestSchema.parse({ prompt: 'x' })).toMatchObject({ n: 1, partial_images: 0, model: 'auto' })
  })

  test('a full plan request is accepted, defaults fill a brief, and the invalid ones are refused', () => {
    roundTrips(planRequestSchema, planRequest)
    expect(planRequestSchema.parse({ brief: 'a lighthouse' })).toEqual({
      brief: 'a lighthouse',
      mode: 'auto',
      intent: 'auto',
      series_context: [],
      preserve_list: [],
      has_references: false,
    })
    for (const [, body] of invalidPlanRequests) expect(planRequestSchema.safeParse(body).success).toBe(false)
  })
})

describe('responses', () => {
  test('the envelope, every stream frame, the plan and the error bodies parse', () => {
    roundTrips(generateResponseSchema, completedResponse)
    for (const frame of [partialFrame, completedFrame, errorFrame]) {
      roundTrips(streamEventSchema, frame)
    }
    roundTrips(planResponseSchema, planResponse)
    roundTrips(errorResponseSchema, errorBody)
    roundTrips(moderationErrorResponseSchema, moderationErrorBody)
  })

  test('the response model is a generatable id, never a retired one, and the cost source is the studio vocabulary', () => {
    expect(IMAGE_MODELS).toEqual(['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst'])
    expect(generateResponseSchema.safeParse({ ...completedResponse, model: 'gpt-image-2' }).success).toBe(false)
    expect(generateResponseSchema.safeParse({ ...completedResponse, cost: { usd: 1, source: 'rate' } }).success).toBe(
      false,
    )
    expect(streamEventSchema.safeParse({ type: 'progress' }).success).toBe(false)
  })
})

describe('limits', () => {
  test('the studio edit limits equal the capability limits the upstream call enforces', () => {
    expect(EDIT_LIMITS).toEqual({ maxImages: 16, maxImageBytes: MAX_EDIT_IMAGE_BYTES, maxMaskBytes: MAX_MASK_BYTES })
  })
})
