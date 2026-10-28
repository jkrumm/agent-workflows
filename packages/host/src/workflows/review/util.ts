/**
 * `fn` over `items`, at most `limit` at a time, results in input order. After the first rejection nothing new is started
 * (items in flight settle on their own) and that rejection is the result.
 */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  let stopped = false
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (!stopped) {
        const i = next++
        if (i >= items.length) return
        try {
          out[i] = await fn(items[i] as T)
        } catch (error) {
          stopped = true
          throw error
        }
      }
    }),
  )
  return out
}

/** A file name is untrusted text: control characters (a newline would forge a line of a prompt) are shown escaped. */
export const escapeName = (name: string) =>
  name.replace(/[\p{Cc}\u2028\u2029]/gu, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`)
