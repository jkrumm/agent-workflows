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
  return bearerCaller(header, new Map([['secret', secret]])) !== null
}

/**
 * Which of several named bearers `Authorization: Bearer <token>` carries, or null. Every known token is compared,
 * hashed and in constant time, whatever matched first, so the timing says nothing about which one (or how much of
 * one) was right. A missing or malformed header never matches, not even an empty token.
 */
export function bearerCaller(header: string | null, known: ReadonlyMap<string, string>): string | null {
  const match = header ? /^Bearer +(\S+)$/i.exec(header) : null
  const candidate = sha256(match?.[1] ?? '')
  let caller: string | null = null
  for (const [name, token] of known) {
    if (crypto.timingSafeEqual(candidate, sha256(token)) && match) caller ??= name
  }
  return caller
}

/** The `WWW-Authenticate` challenge every 401 of a platform process carries. */
export const BEARER_CHALLENGE = { 'www-authenticate': 'Bearer' } as const

/** Why a secret cannot be used, or null. One rule for `createHost` and `loadConfig`; never echoes the value. */
export function secretProblem(secret: string | undefined): string | null {
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    return `AGW_API_SECRET must be set and at least ${MIN_SECRET_LENGTH} characters`
  }
  // A header value never carries whitespace at its ends or inside, so such a secret could never authenticate.
  if (/\s/.test(secret)) return 'AGW_API_SECRET must not contain whitespace (a trailing newline?)'
  return null
}

export function assertSecret(secret: string | undefined): asserts secret is string {
  const problem = secretProblem(secret)
  if (problem) throw new Error(problem)
}
