// Who may call the door, and under which name. The audio process binds 127.0.0.1, so a caller is a process on this
// machine; it presents a bearer from the local caller-token file (`name=token` lines, mode 0600, written by
// `make deploy`). The platform's own API secret is accepted too, as the caller `agw` (verify, the eval harness): it
// already grants the whole API, so it adds no reach. No 1Password item: a token is local to the machine it serves.
import { lstatSync, readFileSync } from 'node:fs'
import { bearerCaller } from '@agent-workflows/host'

export const PLATFORM_CALLER = 'agw'
const NAME = /^[a-z][a-z0-9-]{0,31}$/
const MIN_TOKEN_LENGTH = 32

/**
 * The file's tokens by caller name. Fails naming the file and the line, never a value: a malformed line, a bad or
 * duplicate name, the reserved `agw`, a token shorter than 32 characters or one used twice.
 */
export function parseDoorTokens(text: string, file: string): Map<string, string> {
  const tokens = new Map<string, string>()
  const seen = new Set<string>()
  for (const [index, raw] of text.split('\n').entries()) {
    const line = raw.replace(/\r$/, '').trim()
    if (line === '' || line.startsWith('#')) continue
    const where = `${file}:${index + 1}`
    const eq = line.indexOf('=')
    if (eq < 0) throw new Error(`${where}: expected name=token`)
    const name = line.slice(0, eq).trim()
    const token = line.slice(eq + 1).trim()
    if (!NAME.test(name)) throw new Error(`${where}: a caller name is [a-z][a-z0-9-]*, at most 32 characters`)
    if (name === PLATFORM_CALLER) throw new Error(`${where}: "${PLATFORM_CALLER}" is reserved for the API secret`)
    if (tokens.has(name)) throw new Error(`${where}: caller "${name}" is listed twice`)
    if (token.length < MIN_TOKEN_LENGTH || /\s/.test(token))
      throw new Error(`${where}: the token of "${name}" must be at least ${MIN_TOKEN_LENGTH} characters, no whitespace`)
    if (seen.has(token)) throw new Error(`${where}: the token of "${name}" is another caller's`)
    seen.add(token)
    tokens.set(name, token)
  }
  return tokens
}

/** Reads the file, refusing one that is not a regular file of this user at mode 0600 (it holds bearers). */
export function readDoorTokens(file: string): Map<string, string> {
  let stat: ReturnType<typeof lstatSync>
  try {
    stat = lstatSync(file)
  } catch {
    throw new Error(`door tokens: ${file} is missing (make deploy creates it)`)
  }
  if (!stat.isFile()) throw new Error(`door tokens: ${file} must be a regular file`)
  if ((stat.mode & 0o777) !== 0o600) throw new Error(`door tokens: ${file} must have mode 0600`)
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid())
    throw new Error(`door tokens: ${file} must be owned by the user running the process`)
  return parseDoorTokens(readFileSync(file, 'utf8'), file)
}

/** The caller an `Authorization` header authenticates, or null. */
export type CallerAuth = (authorization: string | null) => string | null

/** The door tokens plus the API secret as `agw`, matched by the host's own constant-time `bearerCaller`. */
export function callerAuth(options: { tokens: ReadonlyMap<string, string>; secret: string }): CallerAuth {
  const known = new Map([[PLATFORM_CALLER, options.secret], ...options.tokens])
  return (authorization) => bearerCaller(authorization, known)
}
