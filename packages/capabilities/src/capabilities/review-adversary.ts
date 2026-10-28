import { z } from 'zod'
import { CapabilityError, fail } from '../errors.ts'
import { type Completion, complete, type LlmDeps, parseJsonLoose, resolve } from '../llm/model-call.ts'
import { defineCapability } from '../procedure.ts'
import { capDiff, reviewPrompt } from './review-prompts.ts'

const finding = z.object({
  severity: z.enum(['blocking', 'improvement', 'discussion']),
  file: z.string(),
  line: z.number().optional(),
  message: z.string(),
})

export const reviewAdversaryInput = z.object({
  diff: z.string().describe('The unified diff under review; cut at 200000 characters'),
  context: z.string().optional().describe('The author’s stated intent, if any'),
})

export const reviewAdversaryOutput = z.object({
  findings: z.array(finding),
  model: z.string(),
  truncatedChars: z.int().nonnegative().describe('Diff characters cut to fit the cap; 0 when nothing was cut'),
})

const answer = z.object({ findings: z.array(finding) })

/**
 * Medium, retried once at low on an empty answer: on the route's model, "high" spent the whole output allowance on
 * reasoning and returned no content in 2 of its first 12 reviews (agent-gateway, 2026-10-23).
 */
const EFFORT = 'medium' as const
const RETRY_EFFORT = 'low' as const

export const createReviewAdversary = (deps: LlmDeps) =>
  defineCapability({
    id: 'review.adversary',
    summary:
      'The cross-family critic: one non-agentic call that argues against merging a diff (route review.adversary)',
    input: reviewAdversaryInput,
    output: reviewAdversaryOutput,
    // Not `agw review route`: the host refuses a command that is a prefix of another, and `agw review` is the workflow.
    cli: { command: ['review-adversary'], stdin: 'diff', defaultFormat: 'json' },
    async handler({ diff, context }, ctx) {
      const route = resolve(deps, 'review.adversary')
      if (route.wire !== 'iu-openai') {
        throw new CapabilityError(
          'NOT_CONFIGURED',
          `review.adversary: wire "${route.wire}" is not the OpenAI chat wire`,
        )
      }
      const { text, truncatedChars } = capDiff(diff)
      const contextBlock = context
        ? `\n\n## Author Context\n\n> ${context}\n\nThis is the author's stated intent. Use it to evaluate whether the changes achieve the goal — not to justify shortcuts. If the implementation doesn't match the intent, that's a blocking finding.`
        : ''
      const prompt = reviewPrompt('adversary')
        .replace('[DIFF]', () => text)
        .replace('[CONTEXT_BLOCK]', () => contextBlock)
      // One request per attempt, streamed, with the transport's idle rule: a slow answer on a big diff is not a failure.
      // Through `complete`, so a provider-balance refusal moves to the route's fallback; the ceiling is the route's own,
      // else room to think (reasoning tokens count against it). The answer is judged here, not by `complete`.
      const ask = (effort: typeof EFFORT | typeof RETRY_EFFORT, start: typeof route) =>
        complete(deps, { routeId: 'review.adversary', prompt, effort, raw: true, ctx }, start)
      let result: Completion = await ask(EFFORT, route)
      // The re-ask goes to the route that answered: a call that fell back stays on the fallback.
      if (!result.text) result = await ask(RETRY_EFFORT, result.route)
      if (!result.text) {
        throw fail(
          'UPSTREAM_ERROR',
          `review.adversary: the model returned no content (stop: ${result.stopDetail ?? result.stop})`,
          {},
        )
      }
      const parsed = parseJsonLoose(result.text)
      if (parsed === null) {
        throw fail('INVALID_OUTPUT', 'review.adversary: the response was not a valid JSON object', {
          attempts: 1,
          reason: 'unparseable JSON output',
        })
      }
      const checked = answer.safeParse(parsed)
      if (!checked.success) {
        throw fail('INVALID_OUTPUT', 'review.adversary: the JSON did not match the schema', {
          attempts: 1,
          reason: 'schema validation failed',
        })
      }
      return { findings: checked.data.findings, model: result.model, truncatedChars }
    },
  })
