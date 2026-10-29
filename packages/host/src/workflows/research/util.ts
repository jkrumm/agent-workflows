import type { Json } from '@agent-workflows/runtime'

/** A JSON value as an object to read fields from; anything else reads as empty. */
export const asRecord = (value: Json | undefined): Record<string, Json> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}

/** An error's message, or the thrown value as text. */
export const message = (error: unknown) => (error instanceof Error ? error.message : String(error))
