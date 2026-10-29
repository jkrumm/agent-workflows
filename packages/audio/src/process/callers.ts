// Who may call the door, and under which name. The audio process binds 127.0.0.1, so a caller is a process on this
// machine; it presents a bearer from the local caller-token file (`tokens.ts`). The platform's own API secret is
// accepted too, as the caller `agw` (verify, the eval harness): it already grants the whole API, so it adds no reach.
// No 1Password item: a token is local to the machine it serves.
import { bearerCaller, bearerKeys } from '@agent-workflows/host'
import { PLATFORM_CALLER } from './tokens.ts'

export { PLATFORM_CALLER, parseDoorTokens, readDoorTokens } from './tokens.ts'

/** The caller an `Authorization` header authenticates, or null. */
export type CallerAuth = (authorization: string | null) => string | null

/** The door tokens plus the API secret as `agw`, hashed once, matched by the host's constant-time `bearerCaller`. */
export function callerAuth(options: { tokens: ReadonlyMap<string, string>; secret: string }): CallerAuth {
  const keys = bearerKeys(new Map([[PLATFORM_CALLER, options.secret], ...options.tokens]))
  return (authorization) => bearerCaller(authorization, keys)
}
