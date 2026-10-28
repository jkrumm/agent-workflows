/** One subprocess call. Helper processes (git, bun install, psql) get a timeout; agent calls never do. */
export interface ExecOptions {
  cwd?: string
  env?: Record<string, string | undefined>
  stdin?: string
  timeoutMs?: number
}

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

export type Exec = (cmd: string, args: string[], options?: ExecOptions) => Promise<ExecResult>

export const exec: Exec = async (cmd, args, options = {}) => {
  const proc = Bun.spawn([cmd, ...args], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdin: options.stdin === undefined ? 'ignore' : new TextEncoder().encode(options.stdin),
    stdout: 'pipe',
    stderr: 'pipe',
    ...(options.timeoutMs ? { timeout: options.timeoutMs, killSignal: 'SIGKILL' as const } : {}),
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, stdout, stderr }
}

/** The last non-empty stdout line parsed as JSON; the `agw` CLIs print one JSON document. */
export function lastJson(stdout: string): unknown {
  const text = stdout.trim()
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    const last =
      text
        .split('\n')
        .filter((l) => l.trim())
        .at(-1) ?? ''
    try {
      return JSON.parse(last)
    } catch {
      return undefined
    }
  }
}

export const brief = (text: string, max = 400) => (text.length > max ? `${text.slice(0, max)}…` : text).trim()
