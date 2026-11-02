import { digestInput, digestOutput } from '@agent-workflows/capabilities'
import type { z } from 'zod'

export {
  DIGEST_KINDS,
  DIGEST_TEXT_LIMITS,
  MAX_DIGEST_ITEMS,
  REPLY_KINDS,
  type DigestResult,
} from '@agent-workflows/capabilities'

/**
 * The workflow's input. `items` is the one property because the CLI reads exactly one property from stdin: the caller pipes
 * the items array to `agw digest`. Every `text` is untrusted data, cut to its kind's limit by the caller.
 */
export const DigestInput = digestInput
export type DigestInputValue = z.output<typeof DigestInput>

/** `{results, model}`: one entry per input item in input order, the answer for its kind or `{id, error}`. */
export const DigestOutput = digestOutput
export type DigestOutputValue = z.output<typeof DigestOutput>
