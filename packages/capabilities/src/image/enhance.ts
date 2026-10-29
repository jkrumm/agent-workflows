import { z } from 'zod'
import type { Ctx } from '../context.ts'
import { fail } from '../errors.ts'
import { complete, type LlmDeps, parseJsonLoose } from '../llm/model-call.ts'
import { defineCapability } from '../procedure.ts'
import type { ResolvedImageDeps } from './deps.ts'
import { estimateCost, snapToNearestPreset } from './estimate.ts'
import { GENERATE_MODELS, pickRoute, QUALITIES } from './generate.ts'
import { composePlaybook, INTENTS, PLAYBOOK_VERSION } from './playbook.ts'
import { validateSize } from './size.ts'

const PLAN_MODES = ['auto', 'full', 'gaps', 'off'] as const
type ModeApplied = Exclude<(typeof PLAN_MODES)[number], 'auto'>

export const enhanceInput = z.object({
  brief: z.string().min(1).max(4_000).describe('The idea in a sentence or a paragraph'),
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
    })
    .describe('Settings `image.generate` takes as they are'),
  estimatedCost: z.object({ perImageUsd: z.number(), totalUsd: z.number() }).nullable(),
  warnings: z.array(warning).describe('A `hard` warning is a policy wall the generation would hit'),
  modeApplied: z.enum(['full', 'gaps', 'off']),
  playbookVersion: z.string(),
  enhanceModel: z.string(),
})
export type EnhanceOutput = z.infer<typeof enhanceOutput>

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
  }),
  /** Spliced onto the brief in passthrough mode only; the model's own `prompt` is never trusted to leave the brief alone there. */
  constraint_block: z.string().optional(),
})
type LlmPlan = z.infer<typeof llmPlan>

const OUTPUT_CONTRACT = `You are the Plan brain for a personal image-generation studio. Given a brief, respond with a SINGLE JSON object and nothing else — no markdown fences, no commentary, no prose before or after it.

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
    "n": <integer 1-10>
  },
  "constraint_block": "<optional trailing constraint clause, e.g. a safety clarification; empty/omitted if none>"
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

function modeInstruction(applied: ModeApplied): string {
  switch (applied) {
    case 'full':
      return "Aggressiveness: FULL. Fully enhance the brief per the playbook's canonical ordering, filling every reasonable gap (lighting, composition, medium, mood, style anchor)."
    case 'gaps':
      return 'Aggressiveness: GAP-FILL ONLY. The brief is already fairly complete — only fill missing slots that materially affect the output. Do not rewrite or embellish what is already stated.'
    case 'off':
      return 'Aggressiveness: PASSTHROUGH. Do NOT rewrite the brief\'s prose at all — the "prompt" field is ignored in this mode and the raw brief is used verbatim. Your job here is only to: (1) evaluate policy risk into "warnings", (2) propose settings, (3) optionally propose a single trailing "constraint_block" (e.g. a safety clarification) — leave it empty if none is needed. Still fill "prompt" with your best-effort echo of the input for logging purposes.'
  }
}

export function planMessages(input: z.output<typeof enhanceInput>, applied: ModeApplied) {
  const intent =
    input.intent === 'auto'
      ? 'Detect the intent from the brief and report it as "intent.detected", choosing the closest match from the enum.'
      : `The intent is fixed to "${input.intent}" — do not redetect it; set "intent.detected" to "${input.intent}" with confidence 1.`
  const user = [
    modeInstruction(applied),
    intent,
    `Brief: "${input.brief}"`,
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

const ROUTING_WHY = (edit: boolean, quality: string) =>
  edit
    ? 'editing/reference precision'
    : ['high', 'xhigh', 'max'].includes(quality)
      ? `a ${quality}-quality final render`
      : `a ${quality === 'auto' ? 'default' : quality}-quality draft`

/** The model's proposal, disposed by code: the router picks the model, an invalid size snaps to the nearest preset. Every correction is a note. */
export function resolveSettings(proposed: LlmPlan['proposed_settings'], hasReferences: boolean) {
  const notes: string[] = []
  const edit = hasReferences
  const route = pickRoute(proposed.model, proposed.quality, edit)
  const model: 'flare' | 'sunburst' = route === 'image.flare' ? 'flare' : 'sunburst'
  if (proposed.model === 'auto') notes.push(`Routed to ${model}: ${ROUTING_WHY(edit, proposed.quality)}.`)
  let size = proposed.size
  const sizeError = validateSize(size)
  if (sizeError) {
    const snapped = snapToNearestPreset(size)
    notes.push(`Requested size "${size}" is invalid (${sizeError}); snapped to ${snapped}.`)
    size = snapped
  }
  return {
    settings: {
      endpoint: edit ? ('edit' as const) : ('generate' as const),
      model,
      size,
      quality: proposed.quality,
      background: proposed.background,
      n: proposed.n,
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
    cli: { positional: ['brief'], defaultFormat: 'json' },
    async handler(input, ctx: Ctx) {
      const route = deps.route('image.enhance')
      const applied = modeApplied(input.mode, input.brief)
      const { system, user } = planMessages(input, applied)

      // The route is pinned: a re-ask stays on the route that answered (the planner has no fallback).
      // biome-ignore lint/suspicious/noExplicitAny: `image.enhance` joins the route table when the registry lands; the id is only a label until then
      const routeId = 'image.enhance' as any
      let prompt = user
      let reason = ''
      let plan: LlmPlan | undefined
      for (let attempt = 1; attempt <= 2 && !plan; attempt++) {
        const { text } = await complete(llm, { routeId, system, prompt, json: true, ctx }, route)
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

      // In passthrough the model's own prompt is not trusted to leave the brief alone: the brief is the prompt.
      const finalPrompt =
        applied !== 'off'
          ? plan.prompt
          : plan.constraint_block?.trim()
            ? `${input.brief.trim()}\n\n${plan.constraint_block.trim()}`
            : input.brief.trim()
      const { settings, notes } = resolveSettings(plan.proposed_settings, input.hasReferences)
      const price = deps.route(settings.model === 'flare' ? 'image.flare' : 'image.sunburst').price
      return {
        intent: input.intent === 'auto' ? plan.intent : { detected: input.intent, confidence: plan.intent.confidence },
        prompt: finalPrompt,
        additions: applied === 'off' ? [] : plan.additions,
        verbatimCheck: checkVerbatim(input.brief, finalPrompt),
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
