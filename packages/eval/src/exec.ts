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

export const brief = (text: string, max = 400) => (text.length > max ? `${text.slice(0, max)}…` : text).trim()
