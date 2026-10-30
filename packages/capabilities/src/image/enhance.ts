import { z } from 'zod'
import type { Ctx } from '../context.ts'
import { fail } from '../errors.ts'
import { complete, type LlmDeps, parseJsonLoose } from '../llm/model-call.ts'
import { defineCapability } from '../procedure.ts'
import type { ResolvedImageDeps } from './deps.ts'
import { estimateCost, snapToNearestPreset } from './estimate.ts'
import { composePlaybook, INTENTS, PLAYBOOK_VERSION } from './playbook.ts'
import { validateSize } from './size.ts'
import {
  BACKGROUNDS,
  GENERATE_MODELS,
  INPUT_FIDELITIES,
  MODEL_CAPABILITIES,
  MODELS,
  MODERATIONS,
  MAX_PARTIAL_IMAGES,
  pickRoute,
  QUALITIES,
  routingWhy,
} from './studio.ts'

const PLAN_MODES = ['auto', 'full', 'gaps', 'off'] as const
type ModeApplied = Exclude<(typeof PLAN_MODES)[number], 'auto'>

/** Words in a style guide's prompt fragment (image-gateway `MAX_PROMPT_FRAGMENT_WORDS`). */
const MAX_PROMPT_FRAGMENT_WORDS = 40

const overrides = z
  .object({
    model: z.enum(MODELS).optional(),
    size: z.string().optional(),
    quality: z.enum(QUALITIES).optional(),
    background: z.enum(BACKGROUNDS).optional(),
    n: z.int().min(1).max(10).optional(),
    moderation: z.enum(MODERATIONS).optional(),
    inputFidelity: z.enum(INPUT_FIDELITIES).optional(),
    partialImages: z.int().min(0).max(MAX_PARTIAL_IMAGES).optional(),
  })
  .describe('Settings the user pinned: echoed verbatim into the plan settings, never derived over')

const styleGuide = z.object({
  promptFragment: z.string().refine((value) => wordCount(value) <= MAX_PROMPT_FRAGMENT_WORDS, {
    message: `promptFragment must be ${MAX_PROMPT_FRAGMENT_WORDS} words or fewer`,
  }),
  palette: z.array(z.string()).default([]),
  avoid: z.array(z.string()).default([]),
  refImageCount: z.int().min(0).default(0),
})

export const enhanceInput = z
  .object({
    brief: z.string().min(1).max(4_000).optional().describe('The idea in a sentence or a paragraph; or currentPrompt'),
    currentPrompt: z
      .string()
      .min(1)
      .max(32_000)
      .optional()
      .describe('An iteration: the accepted prompt to carry forward, instead of a brief'),
    delta: z.string().min(1).max(4_000).optional().describe('What changes; only with currentPrompt'),
    hasReferences: z.boolean().default(false).describe('Reference images will be attached: the plan is for an edit'),
    intent: z
      .enum(INTENTS)
      .default('auto')
      .describe('Pin the kind of image (icon, hero, ...); auto detects it from the brief'),
    mode: z
      .enum(PLAN_MODES)
      .default('auto')
      .describe(
        'How much to rewrite. auto: under 25 words full, 25-100 gap-fill only, over 100 untouched. off: policy check and settings only',
      ),
    overrides: overrides.optional(),
    styleGuide: styleGuide.optional().describe('A style guide snapshot to weave into the prompt'),
    seriesContext: z
      .array(z.object({ prompt: z.string(), settings: z.record(z.string(), z.unknown()).default({}) }))
      .default([])
      .describe('Prior accepted prompts of the series whose vocabulary the plan reuses'),
    preserveList: z.array(z.string()).default([]).describe('What must survive an iteration unchanged'),
  })
  .superRefine((input, ctx) => {
    const hasBrief = input.brief !== undefined
    const hasCurrent = input.currentPrompt !== undefined
    if (hasBrief === hasCurrent) {
      ctx.addIssue({
        code: 'custom',
        path: [hasBrief ? 'currentPrompt' : 'brief'],
        message: 'exactly one of brief or currentPrompt is required',
      })
    }
    if (input.delta !== undefined && !hasCurrent) {
      ctx.addIssue({ code: 'custom', path: ['delta'], message: 'delta is only valid together with currentPrompt' })
    }
  })

const intentResult = z.object({ detected: z.enum(INTENTS), confidence: z.number().min(0).max(1) })
const warning = z.object({
  code: z.string(),
  severity: z.enum(['warn', 'rewrite', 'hard']),
  message: z.string(),
  suggested_rewrite: z.string().optional(),
  moderation_suggestion: z.enum(['auto', 'low']).optional(),
  predicted_stage: z.enum(['input', 'output']).optional(),
})
const addition = z.object({ slot: z.string(), text: z.string() })

export const enhanceOutput = z.object({
  intent: intentResult,
  prompt: z.string().describe('The finished prompt, medium first, ending in the constraint block'),
  additions: z.array(addition),
  verbatimCheck: z
    .object({ ok: z.boolean(), missing: z.array(z.string()) })
    .describe('Every concrete token of the brief survived into the prompt'),
  assumptions: z.array(z.string()),
  settings: z
    .object({
      endpoint: z.enum(['generate', 'edit']),
      model: z.enum(GENERATE_MODELS),
      size: z.string(),
      quality: z.enum(QUALITIES),
      background: z.enum(['transparent', 'opaque', 'auto']),
      n: z.int().min(1).max(10),
      moderation: z.enum(MODERATIONS),
      inputFidelity: z.enum(INPUT_FIDELITIES).optional().describe('Only where the model takes it (neither does today)'),
      partialImages: z.int().min(0).max(MAX_PARTIAL_IMAGES).describe('Preview frames for a live single-image stream'),
    })
    .describe('Settings `image.generate` takes as they are; the studio door also takes moderation and partialImages'),
  estimatedCost: z.object({ perImageUsd: z.number(), totalUsd: z.number() }).nullable(),
  warnings: z.array(warning).describe('A `hard` warning is a policy wall the generation would hit'),
  modeApplied: z.enum(['full', 'gaps', 'off']),
  playbookVersion: z.string(),
  enhanceModel: z.string(),
})
export type EnhanceOutput = z.infer<typeof enhanceOutput>
/** What a caller passes `image.enhance` (defaults not yet applied). */
export type EnhanceParams = z.input<typeof enhanceInput>

/** The model's part of the plan; everything else is derived by code. Its settings are advisory. */
const llmPlan = z.object({
  intent: intentResult,
  prompt: z.string().min(1),
  additions: z.array(addition).default([]),
  assumptions: z.array(z.string()).default([]),
  warnings: z.array(warning).default([]),
  proposed_settings: z.object({
    // A proposal naming a retired model degrades to "let the router pick" instead of failing the plan on a field code overrules.
    model: z
      .enum(['auto', ...GENERATE_MODELS])
      .default('auto')
      .catch('auto'),
    size: z.string().default('auto'),
    quality: z.enum(QUALITIES).default('auto'),
    background: z.enum(['transparent', 'opaque', 'auto']).default('auto'),
    n: z.int().min(1).max(10).default(1),
    moderation: z.enum(MODERATIONS).default('auto'),
    input_fidelity: z.enum(INPUT_FIDELITIES).optional(),
    partial_images: z.int().min(0).max(MAX_PARTIAL_IMAGES).default(1),
  }),
  /** Spliced onto the brief in passthrough mode only; the model's own `prompt` is never trusted to leave the brief alone there. */
  constraint_block: z.string().optional(),
})
type LlmPlan = z.infer<typeof llmPlan>

const OUTPUT_CONTRACT = `You are the Plan brain for a personal image-generation studio. Given a brief (or an iteration request), respond with a SINGLE JSON object and nothing else — no markdown fences, no commentary, no prose before or after it.

The JSON object must have exactly this shape:
{
  "intent": { "detected": "<icon|hero|painterly|technical|diagram|article|figure-art|texture>", "confidence": <0-1 number> },
  "prompt": "<the finished image-generation prompt, per the playbook's canonical ordering and terminal constraint block>",
  "additions": [{ "slot": "<gap filled, e.g. lighting>", "text": "<the added text>" }],
  "assumptions": ["<free-text notes on what you assumed or corrected>"],
  "warnings": [{ "code": "<short_code>", "severity": "warn"|"rewrite"|"hard", "message": "<explanation>", "suggested_rewrite": "<optional compliant rewrite>", "moderation_suggestion": "low", "predicted_stage": "input"|"output" }],
  "proposed_settings": {
    "model": "flare"|"sunburst"|"auto" (prefer "auto" — drafts route to flare, edits and high/xhigh/max finals to sunburst),
    "size": "<'auto', a preset (1024x1024, 1536x1024, 1024x1536), or a custom WxH>",
    "quality": "low"|"medium"|"high"|"xhigh"|"max"|"auto",
    "background": "transparent"|"opaque"|"auto",
    "n": <integer 1-10>,
    "moderation": "auto"|"low",
    "input_fidelity": "high"|"low" (omit — no available model supports it; it is rejected outright),
    "partial_images": <integer 0-3, 1 for a live single-image preview, 0 when n is above 1>
  },
  "constraint_block": "<optional trailing constraint clause, e.g. a restated preserve list or a safety clarification; empty/omitted if none>"
}

Do not include an "endpoint" field — it is derived from whether reference images are attached. Every setting you propose is advisory: it is validated against the real model-capability matrix and may be corrected.`

const FULL_MAX_WORDS = 25
const GAPS_MAX_WORDS = 100

const wordCount = (text: string) => text.trim().split(/\s+/).filter(Boolean).length

/** Under 25 words full, 25-100 gap-fill, over 100 passthrough; an explicit mode always wins. Code decides this, never the model. */
export function modeApplied(mode: (typeof PLAN_MODES)[number], brief: string): ModeApplied {
  if (mode !== 'auto') return mode
  const count = wordCount(brief)
  return count < FULL_MAX_WORDS ? 'full' : count <= GAPS_MAX_WORDS ? 'gaps' : 'off'
}

function modeInstruction(applied: ModeApplied, iteration: boolean): string {
  switch (applied) {
    case 'full':
      return "Aggressiveness: FULL. Fully enhance the brief per the playbook's canonical ordering, filling every reasonable gap (lighting, composition, medium, mood, style anchor)."
    case 'gaps':
      return 'Aggressiveness: GAP-FILL ONLY. The brief is already fairly complete — only fill missing slots that materially affect the output. Do not rewrite or embellish what is already stated.'
    case 'off':
      if (iteration) {
        return 'Aggressiveness: PASSTHROUGH. Do NOT rewrite the current prompt\'s prose at all — the "prompt" field is ignored in this mode and the raw current prompt is used verbatim. Your job here is only to: (1) evaluate policy risk into "warnings", (2) propose settings, (3) optionally propose a single trailing "constraint_block" (e.g. a restated preserve list or a safety clarification) — leave it empty if none is needed. Still fill "prompt" with your best-effort echo of the input for logging purposes.'
      }
      return 'Aggressiveness: PASSTHROUGH. Do NOT rewrite the brief\'s prose at all — the "prompt" field is ignored in this mode and the raw brief is used verbatim. Your job here is only to: (1) evaluate policy risk into "warnings", (2) propose settings, (3) optionally propose a single trailing "constraint_block" (e.g. a safety clarification) — leave it empty if none is needed. Still fill "prompt" with your best-effort echo of the input for logging purposes.'
  }
}

type EnhanceInput = z.output<typeof enhanceInput>

function briefOrDeltaSection(input: EnhanceInput): string {
  if (input.currentPrompt === undefined) return `Brief: "${input.brief}"`
  const preserve = input.preserveList.length > 0 ? input.preserveList.join(', ') : 'none specified'
  const delta = input.delta ?? '(no delta given — treat as a verbatim re-run request)'
  return [
    'This is an iteration on an existing accepted prompt.',
    `Current accepted prompt: "${input.currentPrompt}"`,
    `Requested change (the delta): "${delta}"`,
    `Preserve list (must survive unchanged; re-state it in "constraint_block"): ${preserve}`,
    'Apply ONLY the delta — do not otherwise rewrite the current prompt.',
  ].join('\n')
}

function styleGuideSection(input: EnhanceInput): string | null {
  if (!input.styleGuide) return null
  const { promptFragment, palette, avoid, refImageCount } = input.styleGuide
  const parts = [`Attached style guide — weave this fragment verbatim into the prompt: "${promptFragment}"`]
  if (palette.length > 0) parts.push(`Palette (verbatim hexes, do not alter): ${palette.join(', ')}`)
  if (avoid.length > 0) parts.push(`Avoid: ${avoid.join(', ')}`)
  if (refImageCount > 0) parts.push(`${refImageCount} style reference image(s) will ride along.`)
  return parts.join('\n')
}

function seriesContextSection(input: EnhanceInput): string | null {
  if (input.seriesContext.length === 0) return null
  const prompts = input.seriesContext.map((entry) => `- ${entry.prompt}`).join('\n')
  return `This brief belongs to an ongoing series. Reuse the established vocabulary (medium, lighting, palette) from these prior accepted prompts verbatim; vary only the declared subject/delta:\n${prompts}`
}

/** The pinned settings under the names the planner answers in (`proposed_settings`). */
function overridesSection(pinned: EnhanceInput['overrides']): string | null {
  if (!pinned) return null
  const { inputFidelity, partialImages, ...rest } = pinned
  const wire = {
    ...rest,
    ...(inputFidelity !== undefined ? { input_fidelity: inputFidelity } : {}),
    ...(partialImages !== undefined ? { partial_images: partialImages } : {}),
  }
  if (Object.keys(wire).length === 0) return null
  return `The user has pinned these settings — do not propose anything that contradicts them (they are applied regardless of what you propose): ${JSON.stringify(wire)}`
}

export function planMessages(input: EnhanceInput, applied: ModeApplied) {
  const intent =
    input.intent === 'auto'
      ? 'Detect the intent from the brief and report it as "intent.detected", choosing the closest match from the enum.'
      : `The intent is fixed to "${input.intent}" — do not redetect it; set "intent.detected" to "${input.intent}" with confidence 1.`
  const user = [
    modeInstruction(applied, input.currentPrompt !== undefined),
    intent,
    briefOrDeltaSection(input),
    styleGuideSection(input),
    seriesContextSection(input),
    overridesSection(input.overrides),
    input.hasReferences
      ? 'The user has attached reference image(s) — this plan will run through the edit endpoint.'
      : null,
  ]
    .filter((section): section is string => section !== null)
    .join('\n\n')
  return { system: `${composePlaybook(input.intent)}\n\n---\n\n${OUTPUT_CONTRACT}`, user }
}

/** Every quoted string and concrete token (numbers, hex colours, capitalised names) of a text; the first word is only sentence case. */
export function verbatimTokens(text: string): string[] {
  const tokens = new Set<string>()
  for (const match of text.matchAll(/"([^"]+)"/g)) if (match[1]) tokens.add(match[1])
  for (const match of text.matchAll(/'([^']+)'/g)) if (match[1]) tokens.add(match[1])
  for (const match of text.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) tokens.add(match[0])
  for (const match of text.matchAll(/\b\d+(?:\.\d+)?\b/g)) tokens.add(match[0])
  text.split(/\s+/).forEach((word, index) => {
    if (index === 0) return
    const clean = word.replace(/^[^A-Za-z0-9#]+|[^A-Za-z0-9#]+$/g, '')
    if (/^[A-Z][a-zA-Z]{2,}$/.test(clean)) tokens.add(clean)
  })
  return [...tokens]
}

export function checkVerbatim(source: string, prompt: string) {
  const missing = verbatimTokens(source).filter((token) => !prompt.includes(token))
  return { ok: missing.length === 0, missing }
}

/**
 * The model's proposal, disposed by code. Pinned `overrides` replace the proposal first, field by field, and are echoed
 * verbatim; the router then picks the model, an invalid size snaps to the nearest preset, and an `inputFidelity` the model
 * would answer with a 400 is dropped. Every correction is a note.
 */
export function resolveSettings(
  proposed: LlmPlan['proposed_settings'],
  hasReferences: boolean,
  pinned: EnhanceInput['overrides'] = undefined,
) {
  const notes: string[] = []
  const edit = hasReferences
  const merged = {
    model: pinned?.model ?? proposed.model,
    size: pinned?.size ?? proposed.size,
    quality: pinned?.quality ?? proposed.quality,
    background: pinned?.background ?? proposed.background,
    n: pinned?.n ?? proposed.n,
    moderation: pinned?.moderation ?? proposed.moderation,
    inputFidelity: pinned?.inputFidelity ?? proposed.input_fidelity,
    partialImages: pinned?.partialImages ?? proposed.partial_images,
  }
  const seat = pickRoute(merged.model, merged.quality, edit)
  const model: 'flare' | 'sunburst' = seat === 'image.flare' ? 'flare' : 'sunburst'
  if (merged.model === 'auto') notes.push(`Routed to ${model}: ${routingWhy(edit, merged.quality)}.`)
  let size = merged.size
  const sizeError = validateSize(size)
  if (sizeError) {
    const snapped = snapToNearestPreset(size)
    notes.push(`Requested size "${size}" is invalid (${sizeError}); snapped to ${snapped}.`)
    size = snapped
  }
  let inputFidelity = merged.inputFidelity
  if (inputFidelity !== undefined && !(edit && MODEL_CAPABILITIES[seat].inputFidelity)) {
    notes.push(`Dropped input_fidelity: ${model} does not take it${edit ? '' : ' (and only edits would)'}.`)
    inputFidelity = undefined
  }
  // Streaming is for one image: an unpinned proposal that asks for previews of several is corrected, a pinned one is the user's.
  let partialImages = merged.partialImages
  if (partialImages > 0 && merged.n > 1 && pinned?.partialImages === undefined) {
    notes.push(`Set partialImages to 0: streaming previews need n=1, the plan has n=${merged.n}.`)
    partialImages = 0
  }
  return {
    settings: {
      endpoint: edit ? ('edit' as const) : ('generate' as const),
      model,
      size,
      quality: merged.quality,
      background: merged.background,
      n: merged.n,
      moderation: merged.moderation,
      ...(inputFidelity !== undefined ? { inputFidelity } : {}),
      partialImages,
    },
    notes,
  }
}

const RETRY_ECHO_CHARS = 4_000

export function createEnhance(deps: ResolvedImageDeps, llm: LlmDeps) {
  return defineCapability({
    id: 'image.enhance',
    summary:
      'Turn an image brief into a playbook-conditioned prompt, derived settings, an estimated cost and policy warnings',
    input: enhanceInput,
    output: enhanceOutput,
    // `agw image` is the workflow, and the host refuses a command that is the prefix of another: one hyphenated word.
    cli: { command: ['image-enhance'], positional: ['brief'], defaultFormat: 'json' },
    async handler(input, ctx: Ctx) {
      const route = deps.route('image.enhance')
      // The text the gate and the verbatim check read: what this round adds (the brief, or an iteration's delta).
      const source = input.brief ?? input.delta ?? ''
      const applied = modeApplied(input.mode, source)
      const { system, user } = planMessages(input, applied)

      // The route is pinned: a re-ask stays on the route that answered (the planner has no fallback).
      let prompt = user
      let reason = ''
      let plan: LlmPlan | undefined
      for (let attempt = 1; attempt <= 2 && !plan; attempt++) {
        const { text } = await complete(llm, { routeId: 'image.enhance', system, prompt, json: true, ctx }, route)
        const parsed = parseJsonLoose(text)
        const checked = parsed === null ? null : llmPlan.safeParse(parsed)
        if (checked?.success) plan = checked.data
        else {
          reason =
            checked === null
              ? 'the response was not a valid JSON object'
              : `the JSON did not match the schema: ${checked.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`
          prompt = `${user}\n\n---\nRETRY: your previous response was rejected: ${reason}\n\nPrevious response (truncated):\n${text.slice(0, RETRY_ECHO_CHARS)}\n\nReply again with ONLY the corrected JSON object — no commentary, no code fences.`
        }
      }
      if (!plan)
        throw fail('INVALID_OUTPUT', `image.enhance: planner output rejected after 2 attempts, ${reason}`, {
          attempts: 2,
          reason,
        })

      // In passthrough the model's own prompt is not trusted to leave the brief alone: the brief (or current prompt) is the prompt.
      const base = (input.currentPrompt ?? input.brief ?? '').trim()
      const finalPrompt =
        applied !== 'off'
          ? plan.prompt
          : plan.constraint_block?.trim()
            ? `${base}\n\n${plan.constraint_block.trim()}`
            : base
      const { settings, notes } = resolveSettings(plan.proposed_settings, input.hasReferences, input.overrides)
      const price = deps.route(settings.model === 'flare' ? 'image.flare' : 'image.sunburst').price
      return {
        intent: input.intent === 'auto' ? plan.intent : { detected: input.intent, confidence: plan.intent.confidence },
        prompt: finalPrompt,
        additions: applied === 'off' ? [] : plan.additions,
        verbatimCheck: checkVerbatim(source, finalPrompt),
        assumptions: [...plan.assumptions, ...notes],
        settings,
        estimatedCost:
          price?.kind === 'image-tokens'
            ? estimateCost({
                quality: settings.quality,
                size: settings.size,
                n: settings.n,
                outputPerM: price.outputPerM,
              })
            : null,
        warnings: plan.warnings,
        modeApplied: applied,
        playbookVersion: PLAYBOOK_VERSION,
        enhanceModel: route.model,
      }
    },
  })
}
