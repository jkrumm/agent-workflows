import type { ErrorKind } from '@agent-workflows/runtime'

/** How a door run ends for the status its caller was answered with: the caller's bad request is `invalid_input`. */
export const errorKindOfStatus = (status: number): ErrorKind =>
  status === 400 || status === 413 || status === 422 ? 'invalid_input' : 'error'
