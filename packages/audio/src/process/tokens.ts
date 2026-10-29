// The door's caller-token file (`name=token` lines, mode 0600, written by `make deploy`): read and validated here,
// with no import beyond node and the host's `auth` module (itself node-only), so `make deploy` checks the file with
// this very module before it stops anything. The caller-name rule is the host's, one source.
import { lstatSync, readFileSync } from 'node:fs'
import { CALLER_PATTERN, PLATFORM_CALLER } from '@agent-workflows/host/auth'

export { PLATFORM_CALLER }
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
    if (!CALLER_PATTERN.test(name)) throw new Error(`${where}: a caller name is [a-z][a-z0-9-]*, at most 32 characters`)
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
