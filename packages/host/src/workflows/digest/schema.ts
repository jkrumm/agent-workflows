import { digestInput, digestOutput } from '@agent-workflows/capabilities'

/**
 * The workflow's input. `items` is the one property because the CLI reads exactly one property from stdin: the caller pipes
 * the items array to `agw digest`. Every `text` is untrusted data, cut to its kind's limit by the caller.
 */
export const DigestInput = digestInput

/** `{results, model}`: one entry per input item in input order, the answer for its kind or `{id, error}`. */
export const DigestOutput = digestOutput
