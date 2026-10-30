// The studio's wire contract, mirrored: what the MacBook studio app (image-gateway `app/src/lib/gateway.ts`) sends and
// reads, field for field, snake_case. The source of truth is the studio's `shared/src/{contract,plan}.ts`; nothing is
// imported from there. `test/image-door-contract.test.ts` parses fixtures copied from those schemas, so a drift on
// either side fails a test. Only the shapes the door speaks are mirrored (no sidecar, no rules, no cost estimates).
import { DEFAULT_ROUTES } from '@agent-workflows/routes'
import { z } from 'zod'

/**
 * The models the studio generates with, by the ids it knows: the route table's own
 * default ids for the two image seats (model ids live in the table and nowhere else, `packages/routes/src/guard.test.ts`).
 * The door answers with one of these for the seat that served the request, whatever `AGW_ROUTES` maps the seat to; the
 * contract test pins the two ids to the studio's, so a table change that would break the app's enum fails there.
 */
export const IMAGE_MODELS = [DEFAULT_ROUTES['image.flare'].model, DEFAULT_ROUTES['image.sunburst'].model] as const
export type ImageModel = string

/** An id an older app build still sends; routed like `auto` and reported as routed, naming it. */
export const LEGACY_REQUEST_MODELS = ['gpt-image-2'] as const

/** Upstream limits of the edit path (`EDIT_LIMITS`). */
export const EDIT_LIMITS = {
  maxImages: 16,
  maxImageBytes: 50 * 1024 * 1024,
  maxMaskBytes: 4 * 1024 * 1024,
} as const

export const INPUT_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const

const commonImageFields = {
  prompt: z.string().min(1).max(32_000),
  model: z.enum([...IMAGE_MODELS, ...LEGACY_REQUEST_MODELS, 'auto'] as const).default('auto'),
  size: z
    .string()
    .regex(/^(auto|\d{2,4}x\d{2,4})$/, "size must be 'auto' or 'WxH'")
    .default('auto'),
  quality: z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'auto']).default('auto'),
  background: z.enum(['transparent', 'opaque', 'auto']).default('auto'),
  output_format: z.enum(['png', 'webp', 'jpeg']).default('png'),
  output_compression: z.number().int().min(0).max(100).optional(),
  n: z.number().int().min(1).max(10).default(1),
  moderation: z.enum(['auto', 'low']).default('auto'),
}

const streamingRequiresSingleImage = (req: { partial_images: number; n: number }, ctx: z.RefinementCtx): void => {
  if (req.partial_images > 0 && req.n > 1) {
    ctx.addIssue({
      code: 'custom',
      path: ['partial_images'],
      message: 'streaming (partial_images > 0) is only supported with n=1',
    })
  }
}

export const generateRequestSchema = z
  .object({
    ...commonImageFields,
    /** Preview frames before the final image; above 0 the answer is an SSE stream. */
    partial_images: z.number().int().min(0).max(3).default(0),
  })
  .superRefine(streamingRequiresSingleImage)
export type GenerateRequest = z.infer<typeof generateRequestSchema>

/** The non-file fields of `POST /edit`: on the wire every value is a string, so they are coerced. */
export const editRequestSchema = z
  .object({
    ...commonImageFields,
    output_compression: z.coerce.number().int().min(0).max(100).optional(),
    n: z.coerce.number().int().min(1).max(10).default(1),
    partial_images: z.coerce.number().int().min(0).max(3).default(0),
    input_fidelity: z.enum(['high', 'low']).optional(),
  })
  .superRefine(streamingRequiresSingleImage)
export type EditRequest = z.infer<typeof editRequestSchema>

export const usageSchema = z.object({
  input_tokens: z.number(),
  output_tokens: z.number(),
  total_tokens: z.number(),
  input_tokens_details: z
    .object({
      text_tokens: z.number().optional(),
      image_tokens: z.number().optional(),
      cached_tokens: z.number().optional(),
    })
    .optional(),
  output_tokens_details: z.record(z.string(), z.number()).optional(),
})
export type Usage = z.infer<typeof usageSchema>

export const costSchema = z.object({
  usd: z.number().nullable(),
  source: z.enum(['computed', 'none']),
})
export type Cost = z.infer<typeof costSchema>

export const generatedImageSchema = z.object({
  b64_json: z.string(),
  format: z.enum(['png', 'webp', 'jpeg']),
})

export const generateResponseSchema = z.object({
  id: z.string(),
  created: z.number(),
  model: z.enum(IMAGE_MODELS),
  requested_model: z.enum([...IMAGE_MODELS, ...LEGACY_REQUEST_MODELS, 'auto'] as const),
  routed: z.boolean(),
  routing_reason: z.string().optional(),
  images: z.array(generatedImageSchema),
  size: z.string(),
  quality: z.string(),
  background: z.string(),
  usage: usageSchema,
  cost: costSchema,
  latency_ms: z.number(),
})
export type GenerateResponse = z.infer<typeof generateResponseSchema>

/** `POST /edit` answers with the same envelope as `/generate`. */
export const editResponseSchema = generateResponseSchema

/** SSE frames of `/generate` and `/edit` when `partial_images > 0`: previews, then exactly one `completed` or one `error`. */
export const streamEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('partial_image'),
    partial_image_index: z.number().int().min(0),
    b64_json: z.string(),
    format: z.enum(['png', 'webp', 'jpeg']),
  }),
  z.object({ type: z.literal('completed'), response: generateResponseSchema }),
  z.object({ type: z.literal('error'), error: z.object({ message: z.string(), type: z.string() }) }),
])
export type StreamEvent = z.infer<typeof streamEventSchema>

export const errorResponseSchema = z.object({ error: z.object({ message: z.string(), type: z.string() }) })

/** An error body that also carries a moderation block's code and stage (a superset of `errorResponseSchema`). */
export const moderationErrorResponseSchema = z.object({
  error: z.object({
    message: z.string(),
    type: z.string(),
    code: z.string(),
    moderation_details: z.object({ moderation_stage: z.string(), categories: z.array(z.string()) }),
  }),
})
export type ErrorBody = {
  error: {
    message: string
    type: string
    code?: string
    moderation_details?: { moderation_stage: string; categories: string[] }
  }
}

// --- POST /enhance (the plan contract) ---

export const INTENTS = [
  'auto',
  'icon',
  'hero',
  'painterly',
  'technical',
  'diagram',
  'article',
  'figure-art',
  'texture',
] as const
export const PLAN_MODES = ['auto', 'full', 'gaps', 'off'] as const
export const MAX_PROMPT_FRAGMENT_WORDS = 40

const promptFragmentSchema = z
  .string()
  .refine((value) => value.trim().split(/\s+/).filter(Boolean).length <= MAX_PROMPT_FRAGMENT_WORDS, {
    message: `prompt_fragment must be ${MAX_PROMPT_FRAGMENT_WORDS} words or fewer`,
  })

const planOverridesSchema = z.object({
  model: z.enum([...IMAGE_MODELS, 'auto'] as const).optional(),
  size: z.string().optional(),
  quality: z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'auto']).optional(),
  background: z.enum(['transparent', 'opaque', 'auto']).optional(),
  n: z.number().int().min(1).max(10).optional(),
  moderation: z.enum(['auto', 'low']).optional(),
  input_fidelity: z.enum(['high', 'low']).optional(),
  partial_images: z.number().int().min(0).max(3).optional(),
})

const planStyleGuideSchema = z.object({
  prompt_fragment: promptFragmentSchema,
  palette: z.array(z.string()).default([]),
  avoid: z.array(z.string()).default([]),
  ref_image_count: z.number().int().min(0).default(0),
})

const seriesContextEntrySchema = z.object({
  prompt: z.string(),
  settings: z.record(z.string(), z.unknown()).default({}),
})

export const planRequestSchema = z
  .object({
    brief: z.string().min(1).max(4_000).optional(),
    current_prompt: z.string().min(1).max(32_000).optional(),
    delta: z.string().min(1).max(4_000).optional(),
    mode: z.enum(PLAN_MODES).default('auto'),
    intent: z.enum(INTENTS).default('auto'),
    overrides: planOverridesSchema.optional(),
    style_guide: planStyleGuideSchema.optional(),
    series_context: z.array(seriesContextEntrySchema).default([]),
    preserve_list: z.array(z.string()).default([]),
    has_references: z.boolean().default(false),
  })
  .superRefine((req, ctx) => {
    const hasBrief = req.brief !== undefined
    const hasCurrentPrompt = req.current_prompt !== undefined
    if (hasBrief === hasCurrentPrompt) {
      ctx.addIssue({
        code: 'custom',
        path: [hasBrief ? 'current_prompt' : 'brief'],
        message: 'exactly one of brief or current_prompt is required',
      })
    }
    if (req.delta !== undefined && !hasCurrentPrompt) {
      ctx.addIssue({ code: 'custom', path: ['delta'], message: 'delta is only valid together with current_prompt' })
    }
  })
export type PlanRequest = z.infer<typeof planRequestSchema>

const planWarningSchema = z.object({
  code: z.string(),
  severity: z.enum(['warn', 'rewrite', 'hard']),
  message: z.string(),
  suggested_rewrite: z.string().optional(),
  moderation_suggestion: z.enum(['auto', 'low']).optional(),
  predicted_stage: z.enum(['input', 'output']).optional(),
})

export const planResponseSchema = z.object({
  intent: z.object({ detected: z.enum(INTENTS), confidence: z.number().min(0).max(1) }),
  prompt: z.string(),
  additions: z.array(z.object({ slot: z.string(), text: z.string() })).default([]),
  verbatim_check: z.object({ ok: z.boolean(), missing: z.array(z.string()).default([]) }),
  assumptions: z.array(z.string()).default([]),
  settings: z.object({
    endpoint: z.enum(['generate', 'edit']),
    model: z.enum(IMAGE_MODELS),
    size: z.string(),
    quality: z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'auto']),
    background: z.enum(['transparent', 'opaque', 'auto']),
    n: z.number().int().min(1).max(10),
    moderation: z.enum(['auto', 'low']),
    input_fidelity: z.enum(['high', 'low']).optional(),
    partial_images: z.number().int().min(0).max(3),
  }),
  estimated_cost: z.object({ per_image_usd: z.number(), total_usd: z.number() }),
  warnings: z.array(planWarningSchema).default([]),
  mode_applied: z.enum(PLAN_MODES),
  playbook_version: z.string(),
  enhance_model: z.string(),
})
export type PlanResponse = z.infer<typeof planResponseSchema>
