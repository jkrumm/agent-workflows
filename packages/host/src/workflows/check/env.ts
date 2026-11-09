/**
 * Names that look like a credential, from agent-gateway's `scrubSensitiveEnv` (deliberately broad: a false
 * positive costs a command a variable it almost certainly did not need, a false negative hands a live token to a
 * Makefile of any repo), plus the host's own secrets by name.
 */
const CREDENTIAL = /(TOKEN|SECRET|PASSWORD|PASSWD|_KEY|APIKEY|API_KEY|CREDENTIAL|BEARER|SESSION_ID|AUTHORIZATION)/i
/**
 * The host's database and export configuration, the inference gateway's address (`AGW_GATEWAY_URL`; its token,
 * `AGW_API_SECRET`, is a credential by name) and any IU variable left in the environment.
 */
const HOST_OWN =
  /^(AGW_PG_URL|AGW_TEST_PG_URL|USAGE_PG_URL|USAGE_TEST_PG_URL|DATABASE_URL|AGW_GATEWAY_URL|IU_.*|OTEL_EXPORTER_OTLP_(.*_)?HEADERS)$/i
/**
 * git's env-injected config: `GIT_CONFIG_COUNT` says how many `GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n` pairs follow, and a
 * value can be a credential (an `http.extraHeader`). The family goes together: the `_KEY` pattern alone would strip
 * the keys and keep the count, and git then exits 128 ("missing config key"). The path variables (`GIT_CONFIG_GLOBAL`, …) stay.
 */
const GIT_CONFIG_ENV = /^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/
const CLAUDE_TOKEN = 'CLAUDE_CODE_OAUTH_TOKEN'
/**
 * Make's own recursion state: `-j`/`-k`/`-n`, the jobserver fds, command-line overrides and the level counter. A
 * `make` started under the host's `make check` would run as a sub-make (GNU make 4 prints "Entering directory" and
 * obeys the host's flags); a validated repo's `make` is always top-level.
 */
const MAKE_STATE = /^(MAKELEVEL|MAKEFLAGS|MFLAGS|MAKEOVERRIDES|GNUMAKEFLAGS|MAKEFILES|MAKE_TERMOUT|MAKE_TERMERR)$/

export const isSensitiveEnvName = (name: string) =>
  name === CLAUDE_TOKEN || CREDENTIAL.test(name) || HOST_OWN.test(name) || GIT_CONFIG_ENV.test(name)

/**
 * What a validation command runs with: the host's environment without credentials or make's recursion state, and
 * `PWD` pinned to `cwd` (`Bun.spawn`'s `cwd` does not update it, and a recipe reading `$PWD` would validate the
 * wrong tree). Applies to every spawn, the `make -p -q` probe included: a `$(shell …)` in an untrusted Makefile runs there too.
 */
export function commandEnv(env: Record<string, string | undefined>, cwd: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && !isSensitiveEnvName(name) && !MAKE_STATE.test(name)) result[name] = value
  }
  result.PWD = cwd
  return result
}
