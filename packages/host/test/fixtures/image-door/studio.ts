// Request and response bodies of the MacBook studio's wire contract, written out by hand from the studio's own schemas
// (image-gateway `shared/src/contract.ts`, `plan.ts`) with every field present at least once, in its snake_case wire
// form. The door's mirrored schemas must accept every one of these and reject the invalid ones: a field added, renamed
// or tightened on either side fails `image-door-contract.test.ts`. Refresh this file from the studio's schemas when the
// studio's contract changes, then the door's `contract.ts`.

export const generateRequest = {
  prompt: 'a lighthouse at dusk, oil painting',
  model: 'gpt-image-2.5-sunburst',
  size: '1536x1024',
  quality: 'xhigh',
  background: 'transparent',
  output_format: 'webp',
  output_compression: 80,
  n: 1,
  moderation: 'low',
  partial_images: 3,
} as const

export const generateRequestLegacy = { prompt: 'a lighthouse', model: 'gpt-image-2' } as const

/** A multipart edit request's non-file fields: every value is a string on the wire. */
export const editFields = {
  prompt: 'remove the boat',
  model: 'auto',
  size: '1024x1024',
  quality: 'high',
  background: 'opaque',
  output_format: 'jpeg',
  output_compression: '90',
  n: '1',
  moderation: 'auto',
  partial_images: '2',
  input_fidelity: 'high',
} as const

export const planRequest = {
  current_prompt: 'a lighthouse at dusk, oil painting',
  delta: 'make it winter',
  mode: 'gaps',
  intent: 'painterly',
  overrides: {
    model: 'gpt-image-2.5-flare',
    size: '1024x1024',
    quality: 'medium',
    background: 'opaque',
    n: 2,
    moderation: 'low',
    input_fidelity: 'high',
    partial_images: 0,
  },
  style_guide: {
    prompt_fragment: 'soft north-light, muted teal and ochre',
    palette: ['#1b4d5c', '#d9a441'],
    avoid: ['neon'],
    ref_image_count: 2,
  },
  series_context: [{ prompt: 'a harbour at dawn, oil painting', settings: { size: '1024x1024', n: 1 } }],
  preserve_list: ['the red lamp', 'the stone tower'],
  has_references: true,
} as const

export const completedResponse = {
  id: '6f4a2b1e-0d1c-4f7e-9c52-0a1b2c3d4e5f',
  created: 1_790_000_000,
  model: 'gpt-image-2.5-sunburst',
  requested_model: 'auto',
  routed: true,
  routing_reason: 'routed to gpt-image-2.5-sunburst for editing/reference precision',
  images: [{ b64_json: 'aGVsbG8=', format: 'png' }],
  size: '1024x1024',
  quality: 'high',
  background: 'auto',
  usage: {
    input_tokens: 100,
    output_tokens: 1756,
    total_tokens: 1856,
    input_tokens_details: { text_tokens: 100, image_tokens: 0, cached_tokens: 0 },
    output_tokens_details: { image_tokens: 1756 },
  },
  cost: { usd: 0.0532, source: 'computed' },
  latency_ms: 41_000,
} as const

export const partialFrame = {
  type: 'partial_image',
  partial_image_index: 0,
  b64_json: 'aGVsbG8=',
  format: 'png',
} as const
export const completedFrame = { type: 'completed', response: completedResponse } as const
export const errorFrame = {
  type: 'error',
  error: { message: 'upstream stream error', type: 'upstream_error' },
} as const

export const planResponse = {
  intent: { detected: 'painterly', confidence: 0.82 },
  prompt: 'Oil painting of a lighthouse at dusk in winter, soft north-light.',
  additions: [{ slot: 'lighting', text: 'soft north-light' }],
  verbatim_check: { ok: false, missing: ['the red lamp'] },
  assumptions: ['Routed to sunburst: editing/reference precision.'],
  settings: {
    endpoint: 'edit',
    model: 'gpt-image-2.5-sunburst',
    size: '1024x1024',
    quality: 'high',
    background: 'opaque',
    n: 1,
    moderation: 'auto',
    input_fidelity: 'high',
    partial_images: 1,
  },
  estimated_cost: { per_image_usd: 0.0527, total_usd: 0.0527 },
  warnings: [
    {
      code: 'public_figure',
      severity: 'rewrite',
      message: 'names a real person',
      suggested_rewrite: 'a stylised portrait',
      moderation_suggestion: 'low',
      predicted_stage: 'input',
    },
  ],
  mode_applied: 'gaps',
  playbook_version: '2026-09-23.2',
  enhance_model: 'gpt-6-luna',
} as const

export const errorBody = { error: { message: 'size must be a multiple of 16', type: 'invalid_request_error' } } as const
export const moderationErrorBody = {
  error: {
    message: 'Your request was rejected by the safety system.',
    type: 'upstream_error',
    code: 'moderation_blocked',
    moderation_details: { moderation_stage: 'input', categories: ['violence'] },
  },
} as const

/** Requests the studio's schemas refuse, with the reason. */
export const invalidGenerateRequests: [string, Record<string, unknown>][] = [
  ['an empty prompt', { prompt: '' }],
  ['a retired model', { prompt: 'x', model: 'gpt-image-1.5' }],
  ['a size that is not auto or WxH', { prompt: 'x', size: 'big' }],
  ['n above 10', { prompt: 'x', n: 11 }],
  ['partial_images above 3', { prompt: 'x', partial_images: 4 }],
  ['streaming with n above 1', { prompt: 'x', n: 2, partial_images: 1 }],
  ['output_compression above 100', { prompt: 'x', output_compression: 101 }],
  ['an unknown quality', { prompt: 'x', quality: 'ultra' }],
]

export const invalidPlanRequests: [string, Record<string, unknown>][] = [
  ['neither brief nor current_prompt', {}],
  ['both brief and current_prompt', { brief: 'a', current_prompt: 'b' }],
  ['a delta without current_prompt', { brief: 'a', delta: 'b' }],
  [
    'a style guide fragment over 40 words',
    {
      brief: 'a',
      style_guide: { prompt_fragment: Array.from({ length: 41 }, (_, i) => `w${i}`).join(' ') },
    },
  ],
  ['an override model that is not generatable', { brief: 'a', overrides: { model: 'gpt-image-2' } }],
]
