/** Keys a keyed call steps through before it gives up: each failed attempt left its key holding a failure. */
export const MAX_KEY_ATTEMPTS = 5

/** The key of attempt `n`: the base, then `base:2`, `base:3`, … */
export const attemptKey = (base: string, attempt: number) => (attempt === 1 ? base : `${base}:${attempt}`)

/** What one attempt found under its key: a value, or a run or job that already ended badly there. */
export type KeyAttempt<T> = { value: T } | { failedBefore: true }

/**
 * The one idempotency rule for keyed calls (the judge's capability runs): a repeat adopts what an
 * earlier call finished under the key (a failure that is an answer is finished too: a page gone, a package not
 * found, a refused URL), never an outage or a cancel. Attempt `n` runs under `attemptKey(base, n)`; when the key holds such a failure, the
 * attempt answers `failedBefore` and the next key re-executes. A run still going under a key is waited on, never
 * started twice.
 */
export async function withAttemptKeys<T>(base: string, attempt: (key: string) => Promise<KeyAttempt<T>>): Promise<T> {
  for (let n = 1; n <= MAX_KEY_ATTEMPTS; n++) {
    const outcome = await attempt(attemptKey(base, n))
    if ('value' in outcome) return outcome.value
  }
  throw new Error(`${base}: every one of ${MAX_KEY_ATTEMPTS} keys holds a failed attempt`)
}
