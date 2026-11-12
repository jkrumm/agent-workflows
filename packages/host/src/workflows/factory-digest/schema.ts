import { factoryDigestInput, factoryDigestOutput } from '@agent-workflows/capabilities'
import { z } from 'zod'

/** The workflow's input: the digest request is one property, `input`, because the CLI reads exactly one property from stdin or a file. */
export const FactoryDigestInput = z.object({
  input: factoryDigestInput.describe(
    "A project's recently closed, running, queued and waiting Issues, as JSON on stdin or `--input <file>`",
  ),
})

/** The digest: strict, bounded, every bullet citing Issue ids of the request. */
export const FactoryDigestOutput = factoryDigestOutput
export type FactoryDigestOutputValue = z.output<typeof FactoryDigestOutput>
