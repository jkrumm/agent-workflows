import { createHash } from 'node:crypto'
import type { z } from 'zod'
import { DEV_SHARE, type GtSplit as GtSplitSchema } from '../gt.ts'
import { seededRandom } from '../stats.ts'

type GtSplit = z.infer<typeof GtSplitSchema>

/** `dev` when the first 8 hex of sha256(id), over 2^32, is below `DEV_SHARE`; the same rule for bugs and controls. */
export function splitOf(id: string): GtSplit {
  const head = createHash('sha256').update(id).digest('hex').slice(0, 8)
  return Number.parseInt(head, 16) / 2 ** 32 < DEV_SHARE ? 'dev' : 'test'
}

/** Fisher-Yates under a seed; the input order is the tie-break, so sort it first for a stable result. */
export function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  const random = seededRandom(seed)
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    const swap = out[i] as T
    out[i] = out[j] as T
    out[j] = swap
  }
  return out
}
