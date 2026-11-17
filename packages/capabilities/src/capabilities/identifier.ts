import { z } from 'zod'

/**
 * The routing lines of a factory prompt go outside the data fence, so they are identifiers, never prose: a name from this
 * alphabet cannot carry an instruction.
 */
export const identifier = (max: number, extra = '') =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(new RegExp(`^[A-Za-z0-9._${extra}-]+$`), `must be an identifier (letters, digits, . _ -${extra})`)
