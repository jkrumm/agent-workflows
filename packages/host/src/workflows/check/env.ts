/**
 * Names that look like a credential, from agent-gateway's `scrubSensitiveEnv` (deliberately broad: a false
 * positive costs a command a variable it almost certainly did not need, a false negative hands a live token to a
 * Makefile of any repo), plus the host's own secrets by name.
 */
const CREDENTIAL = /(TOKEN|SECRET|PASSWORD|PASSWD|_KEY|APIKEY|API_KEY|CREDENTIAL|BEARER|SESSION_ID|AUTHORIZATION)/i
/** The host's database and export configuration, and the IU gateway's variables (`IU_API_KEY`, `IU_BASE_URL`). */
const HOST_OWN = /^(AGW_PG_URL|AGW_TEST_PG_URL|DATABASE_URL|IU_.*|OTEL_EXPORTER_OTLP_(.*_)?HEADERS)$/i
const CLAUDE_TOKEN = 'CLAUDE_CODE_OAUTH_TOKEN'

export const isSensitiveEnvName = (name: string) =>
  name === CLAUDE_TOKEN || CREDENTIAL.test(name) || HOST_OWN.test(name)

/**
 * What a validation command runs with: the host's environment without credentials, and `PWD` pinned to `cwd`
 * (`Bun.spawn`'s `cwd` does not update it, and a recipe reading `$PWD` would validate the wrong tree). Applies to
 * every spawn, the `make -p -q` probe included: a `$(shell …)` in an untrusted Makefile runs there too.
 */
export function commandEnv(env: Record<string, string | undefined>, cwd: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && !isSensitiveEnvName(name)) result[name] = value
  }
  result.PWD = cwd
  return result
}
