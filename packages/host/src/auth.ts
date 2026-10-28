import crypto from 'node:crypto'

/** The host refuses to start with a shorter secret (fail closed). */
export const MIN_SECRET_LENGTH = 32

const sha256 = (text: string) => crypto.createHash('sha256').update(text).digest()

/**
 * `Authorization: Bearer <secret>` against the configured secret. Both sides are hashed first, so the comparison
 * is constant-time whatever the length of what the caller sent; a missing or malformed header runs the same
 * comparison against an empty candidate.
 */
export function bearerMatches(header: string | null, secret: string): boolean {
  const match = header ? /^Bearer +(\S+)$/i.exec(header) : null
  return crypto.timingSafeEqual(sha256(match?.[1] ?? ''), sha256(secret))
}

export function assertSecret(secret: string | undefined): asserts secret is string {
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`AGW_API_SECRET must be set and at least ${MIN_SECRET_LENGTH} characters`)
  }
  // A header value never carries whitespace at its ends or inside, so such a secret could never authenticate.
  if (/\s/.test(secret)) throw new Error('AGW_API_SECRET must not contain whitespace (a trailing newline?)')
}
