/** One finished helper process. `code` is null when it never started, was killed, or timed out. */
export type ExecResult = { stdout: string; stderr: string; code: number | null; timedOut: boolean }

export type ExecOptions = {
  cwd: string
  /** A hang guard for a plain helper (git, fallow), never a budget for an agent. */
  timeoutMs: number
  env?: Record<string, string>
  signal?: AbortSignal
}

/** What the review runs helpers through: argv, no shell. Tests replace it; it never throws. */
export type Exec = (argv: readonly string[], options: ExecOptions) => Promise<ExecResult>

type Env = Record<string, string | undefined>

/** git variables that name a program or a config a repo could point at; the host's own `GIT_CONFIG_GLOBAL` and friends are paths and stay. */
const GIT_DENIED =
  /TOKEN|PASS|SECRET|CREDENTIAL|KEY|AUTH(?!OR)|ASKPASS|SSH|EXEC_PATH|EXTERNAL_DIFF|PAGER|EDITOR|PROXY|CONFIG_(?:COUNT|PARAMETERS|KEY_|VALUE_)/i
const GIT_PATH_CONFIG = new Set(['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM'])

/**
 * What a helper (git, fallow, react-doctor) may see of the host's environment: an allowlist, never a copy. A `pr`/`branch`
 * clone is untrusted code and configs read by these tools, and the host's own process holds the API secret and the IU key.
 * `PATH` falls back to the process's own so a test env without one still finds `git`.
 */
export function helperEnv(source: Env): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue
    if (['PATH', 'HOME', 'TMPDIR', 'LANG', 'TERM'].includes(name) || name.startsWith('LC_')) out[name] = value
    else if (name.startsWith('GIT_') && (GIT_PATH_CONFIG.has(name) || !GIT_DENIED.test(name))) out[name] = value
  }
  out.PATH ??= process.env.PATH ?? ''
  return { ...out, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }
}

const TERM_GRACE_MS = 5_000
const DEADLINE_GRACE_MS = 10_000

/** Signals go to the helper's children too: killing only the parent leaves a hung grandchild holding the pipes. */
function killTree(proc: Bun.Subprocess, signal: 'TERM' | 'KILL') {
  try {
    Bun.spawnSync(['pkill', `-${signal}`, '-P', String(proc.pid)])
  } catch {
    // pkill missing: the parent kill below still ends the common case
  }
  if (proc.exitCode === null) proc.kill(signal === 'TERM' ? 'SIGTERM' : 'SIGKILL')
}

/** The helper runner on `source`'s allowlisted environment (`ports.env`). */
export const createExec =
  (source: Env): Exec =>
  async (argv, options) => {
    const failed = (message: string): ExecResult => ({ stdout: '', stderr: message, code: null, timedOut: false })
    let proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>
    try {
      proc = Bun.spawn([...argv], {
        cwd: options.cwd,
        env: { ...helperEnv(source), ...options.env },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      })
    } catch (error) {
      return failed(error instanceof Error ? error.message : String(error))
    }
    const timers: ReturnType<typeof setTimeout>[] = []
    let timedOut = false
    timers.push(
      setTimeout(() => {
        timedOut = true
        killTree(proc, 'TERM')
        timers.push(setTimeout(() => killTree(proc, 'KILL'), TERM_GRACE_MS))
      }, options.timeoutMs),
    )
    const onAbort = () => killTree(proc, 'TERM')
    options.signal?.addEventListener('abort', onAbort, { once: true })
    if (options.signal?.aborted) onAbort()
    const deadline = new Promise<null>((resolve) => {
      timers.push(setTimeout(() => resolve(null), options.timeoutMs + DEADLINE_GRACE_MS))
    })
    const finished = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    finished.catch(() => {}) // a late rejection after the deadline must not go unhandled
    try {
      const outcome = await Promise.race([finished, deadline])
      if (!outcome) {
        killTree(proc, 'KILL')
        return { stdout: '', stderr: 'timed out', code: null, timedOut: true }
      }
      const [stdout, stderr, code] = outcome
      return { stdout, stderr, code: timedOut ? null : code, timedOut }
    } catch (error) {
      return failed(error instanceof Error ? error.message : String(error))
    } finally {
      for (const timer of timers) clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
    }
  }

export const defaultExec: Exec = createExec(process.env)

/** The last `n` non-empty lines of `text`, for a one-line failure reason. */
export function tail(text: string, n = 3): string {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-n)
    .join(' | ')
}
