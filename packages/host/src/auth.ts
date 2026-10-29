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
  return bearerCaller(header, bearerKeys(new Map([['secret', secret]]))) !== null
}

/** Named bearer tokens, hashed once (`bearerKeys`), for `bearerCaller`. */
export interface BearerKeys {
  readonly entries: readonly { readonly name: string; readonly hash: Buffer }[]
}

/** Hashes every token once; build it at start, not per request. */
export function bearerKeys(known: ReadonlyMap<string, string>): BearerKeys {
  return { entries: [...known].map(([name, token]) => ({ name, hash: sha256(token) })) }
}

/**
 * Which of several named bearers `Authorization: Bearer <token>` carries, or null. Every key is compared in constant
 * time against the hashed candidate, whatever matched first, so the timing says nothing about which one (or how much
 * of one) was right. A missing or malformed header never matches, not even an empty token.
 */
export function bearerCaller(header: string | null, keys: BearerKeys): string | null {
  const match = header ? /^Bearer +(\S+)$/i.exec(header) : null
  const candidate = sha256(match?.[1] ?? '')
  let caller: string | null = null
  for (const { name, hash } of keys.entries) {
    if (crypto.timingSafeEqual(candidate, hash) && match) caller ??= name
  }
  return caller
}

/** The caller the API secret authenticates as; a door token may not use the name. */
export const PLATFORM_CALLER = 'agw'

const CALLER_PATTERN = /^[a-z][a-z0-9-]{0,31}$/
// A bare repo-ish name: never a path (no `/`, never a leading dot), at most 64 characters.
const PROJECT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** Who a run is attributed to (`runs.caller`, `runs.project`, `runs.workspace`). */
export type Who = { caller: string; project: string | null; workspace: 'work' | 'private' | null }

/** A caller header that is not valid; the door answers 400, never stamps it. */
export class WhoHeaderError extends Error {
  override name = 'WhoHeaderError'
}

function whoHeader(headers: Headers, name: string, valid: (value: string) => boolean, rule: string): string | null {
  const value = headers.get(name)?.trim()
  if (!value) return null
  if (!valid(value)) throw new WhoHeaderError(`${name} must be ${rule}`)
  return value
}

/** The three caller headers, each validated when present. Throws {@link WhoHeaderError} on a malformed value. */
function declaredWho(headers: Headers): Omit<Who, 'caller'> & { caller: string | null } {
  return {
    caller: whoHeader(headers, 'x-agw-caller', (v) => CALLER_PATTERN.test(v), '[a-z][a-z0-9-]{0,31}'),
    project: whoHeader(headers, 'x-agw-project', (v) => PROJECT_PATTERN.test(v), 'a bare name, [A-Za-z0-9._-]{1,64}'),
    workspace: whoHeader(
      headers,
      'x-agw-workspace',
      (v) => v === 'work' || v === 'private',
      'work or private',
    ) as Who['workspace'],
  }
}

/** The caller headers as the door stamped them (`stampWho`); null without a caller. Throws on a malformed value. */
export function whoFromHeaders(headers: Headers): Who | null {
  const { caller, ...rest } = declaredWho(headers)
  return caller ? { caller, ...rest } : null
}

/**
 * Trust by credential. A named door token fixes the caller to its name and ignores every caller header; the API secret
 * is `agw` and may declare a sub-caller, a project and a workspace (the secret already grants the whole API, so a
 * label adds no reach). Throws {@link WhoHeaderError} for a malformed declaration.
 */
export function resolveWho(credential: string, headers: Headers): Who {
  if (credential !== PLATFORM_CALLER) return { caller: credential, project: null, workspace: null }
  const { caller, ...rest } = declaredWho(headers)
  return { caller: caller ?? PLATFORM_CALLER, ...rest }
}

/**
 * Replaces any caller header the client sent with the resolved ones, so everything behind the door reads credentialed
 * values only.
 */
export function stampWho(headers: Headers, who: Who): void {
  for (const name of ['x-agw-caller', 'x-agw-project', 'x-agw-workspace']) headers.delete(name)
  headers.set('x-agw-caller', who.caller)
  if (who.project) headers.set('x-agw-project', who.project)
  if (who.workspace) headers.set('x-agw-workspace', who.workspace)
}

/**
 * The named tokens the HOST API accepts: `AGW_API_CALLERS`, a comma list of door-token names (`iris,hermes`). A door
 * token is a door credential first (the audio process serves the door and the full API on one port); it becomes an
 * API credential only by being listed here, by the deploy. Unset or empty: none, so only the API secret opens the API.
 * Every problem at once, never a token value: a malformed or reserved name, or one the token file does not have.
 */
export function parseApiCallers(raw: string | undefined, tokens: ReadonlyMap<string, string>): Map<string, string> {
  const callers = new Map<string, string>()
  const problems: string[] = []
  for (const name of (raw ?? '').split(',').map((part) => part.trim())) {
    if (name === '') continue
    if (!CALLER_PATTERN.test(name)) problems.push(`"${name}" is not a caller name ([a-z][a-z0-9-]{0,31})`)
    else if (name === PLATFORM_CALLER) problems.push(`"${PLATFORM_CALLER}" is the API secret's own name`)
    else if (!tokens.has(name)) problems.push(`"${name}" has no token in the door-tokens file`)
    else callers.set(name, tokens.get(name) as string)
  }
  if (problems.length > 0) throw new Error(`AGW_API_CALLERS: ${problems.join('; ')}`)
  return callers
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
