import { existsSync, mkdirSync, readFileSync, readlinkSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { BIN } from './args.ts'
import {
  assertSafeUrl,
  type Credentials,
  cachePath,
  credentials,
  type Env,
  envFilePath,
  HOST_PROCESS,
  type ProcessTarget,
  requireSecret,
  restartBoundS,
  timeoutS,
} from './config.ts'
import { AgwError, kindForStatus } from './exit.ts'
import { buildCommands, type Command, type Document, type Hidden, type Skipped, servedSha } from './spec.ts'

/** The host waits at most this long per request (Bun's `idleTimeout` ceiling is 255 s). */
export const MAX_WAIT_S = 240
/** Added to a wait request's `Prefer: wait`, so the host answers before the client gives up. */
const SLACK_S = 30

/** The host's own rules for `x-agw-caller` and `x-agw-project`; a header outside them is a 400, so the CLI never sends one it inferred. */
export const CALLER_NAME = /^[a-z][a-z0-9-]{0,31}$/
export const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/**
 * The repo a directory belongs to, read from the files git keeps (no process is spawned): the nearest `.git` upward,
 * never `home` itself or above (a `~/.git` must not make the home folder a project). Both answers come from the
 * resolved common git directory, so every linked worktree of a repo is that repo: `name` is its folder (the common
 * directory's parent for `<repo>/.git`, else the directory's own name minus a `.git` suffix: a bare `x.git`, a
 * `--separate-git-dir`), `root` the repo's location (the parent for `<repo>/.git`, else the directory itself). A
 * `.git` that cannot be read falls back to the checkout's own folder. Null outside a repo.
 */
export function gitProject(cwd: string, home?: string): { name: string; root: string } | null {
  const stop = home ? resolve(home) : null
  let dir = resolve(cwd)
  while (dir !== stop) {
    const dotGit = join(dir, '.git')
    if (existsSync(dotGit)) return repoOf(dir, dotGit)
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
  return null
}

function repoOf(checkout: string, dotGit: string): { name: string; root: string } {
  try {
    let common = dotGit
    if (statSync(dotGit).isFile()) {
      const gitdir = /^gitdir: *(.+)$/m.exec(readFileSync(dotGit, 'utf8'))?.[1]?.trim()
      if (!gitdir) throw new Error('no gitdir')
      common = resolve(checkout, gitdir)
      // A linked worktree's admin directory names the shared one; a separate git dir or a submodule is its own.
      const commondir = join(common, 'commondir')
      if (existsSync(commondir)) common = resolve(common, readFileSync(commondir, 'utf8').trim())
    }
    if (basename(common) === '.git') return { name: basename(dirname(common)), root: dirname(common) }
    return { name: basename(common).replace(/\.git$/, '') || basename(common), root: common }
  } catch {
    return { name: basename(checkout), root: checkout }
  }
}

/** A process's working directory: `/proc` on Linux, else `lsof`; null on any failure, never throws. */
function lsofCwd(pid: number): string | null {
  try {
    return readlinkSync(`/proc/${pid}/cwd`)
  } catch {
    // not Linux, or not readable: ask lsof
  }
  try {
    const out = Bun.spawnSync(['lsof', '-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
      stdout: 'pipe',
      stderr: 'ignore',
      timeout: 1000,
    })
    if (out.exitCode !== 0) return null
    const line = out.stdout
      .toString()
      .split('\n')
      .find((l) => l.startsWith('n'))
    return line && line.length > 1 ? line.slice(1) : null
  } catch {
    return null
  }
}

/**
 * Who this CLI call is for, sent as headers (the host trusts them only from the API secret): `x-agw-caller` from
 * `AGW_CALLER`, else `claude-code` inside a Claude Code session (`CLAUDECODE=1`), else `cli`; `x-agw-project` the name
 * of the git repo the cwd is in, and `x-agw-workspace` `work` or `private` from where that working copy lives
 * (`IuRoot` or `SourceRoot`; else none). Only the repo's name and that one word leave the
 * machine, never a path. Hermes sets no marker in its terminal environment, so it names itself with `AGW_CALLER`.
 * When the cwd is outside any repo inside Claude Code (`CLAUDECODE=1`, `CLAUDE_PID` a positive integer), the project is
 * taken from that process's cwd instead (the session's own directory), the only case that spawns a process.
 */
export function callerHeaders(
  env: Env,
  cwd: string,
  processCwd: (pid: number) => string | null = lsofCwd,
): Record<string, string> {
  const declared = env.AGW_CALLER?.trim()
  if (declared && !CALLER_NAME.test(declared)) {
    throw new AgwError('usage', 'AGW_CALLER must match [a-z][a-z0-9-]{0,31}', { hint: 'e.g. AGW_CALLER=hermes' })
  }
  const headers: Record<string, string> = {
    'x-agw-caller': declared || (env.CLAUDECODE === '1' ? 'claude-code' : 'cli'),
  }
  const home = env.HOME?.trim() || homedir()
  let project = gitProject(cwd, home)
  if (!project && env.CLAUDECODE === '1' && /^[1-9]\d*$/.test(env.CLAUDE_PID?.trim() ?? '')) {
    const sessionCwd = processCwd(Number(env.CLAUDE_PID!.trim()))
    if (sessionCwd) project = gitProject(sessionCwd, home)
  }
  if (project && PROJECT_NAME.test(project.name)) {
    headers['x-agw-project'] = project.name
    const place = /(?:^|\/)(IuRoot|SourceRoot)\//.exec(`${project.root}/`)?.[1]
    if (place) headers['x-agw-workspace'] = place === 'IuRoot' ? 'work' : 'private'
  }
  return headers
}

export interface Reply {
  status: number
  body: unknown
}

export interface CallOptions {
  waitS?: number
  idempotencyKey?: string
  /** Aborts the request in flight (the caller was interrupted); the failure is a `network` error. */
  signal?: AbortSignal
  /**
   * Wait out a restart: a refused connection (nothing was sent) is retried for every request, a lost answer or a
   * 502/503/504 only for a read or a request that carries an idempotency key. Default true; a caller that has its
   * own loop (the run wait) or another process to ask first turns it off.
   */
  rideRestart?: boolean
}

interface ErrorBody {
  code?: unknown
  message?: unknown
  data?: unknown
}

const asRecord = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}

/**
 * A schema failure arrives as `Input validation failed` with the issues in `data`; the caller reads `message` and
 * `details` never reach an agent, so the first issue (field, constraint, limit) joins the message.
 */
export function withFirstIssue(message: string, data: unknown): string {
  const issues = asRecord(data).issues
  const first = Array.isArray(issues) ? asRecord(issues[0]) : undefined
  if (!first || typeof first.message !== 'string') return message
  const path = Array.isArray(first.path) ? first.path.map((part) => String(asRecord(part).key ?? part)).join('.') : ''
  const more = (issues as unknown[]).length > 1 ? ` (+${(issues as unknown[]).length - 1} more in details.issues)` : ''
  return `${message}: ${path ? `${path}: ` : ''}${first.message}${more}`
}

function hintFor(kind: AgwError['kind'], env: Env, command: Command | undefined, retryAfter: string | null): string {
  if (kind === 'auth') return `check AGW_API_SECRET (environment or ${envFilePath(env)})`
  if (kind === 'contract_mismatch') return `${BIN} schema --refresh`
  if (kind === 'rate_limited') return retryAfter ? `retry after ${retryAfter}s` : 'retry later'
  if (kind === 'usage' && command) return `${BIN} ${command.words.join(' ')} --help`
  return ''
}

/** The connection was never opened (refused, no such name): nothing reached the process, so another may be asked. */
export class Unreachable extends AgwError {}

/** The request may have reached the process but no answer came back (a reset, a cut body): a restart cuts a request like this. */
class LostAnswer extends AgwError {}

/** The pause before retry n of a refused or lost request: 0.25 s doubling to 2 s. */
const RESTART_BACKOFF_MS = 250
const RESTART_BACKOFF_MAX_MS = 2000
/** The wait is silent for this long, then says so once. */
const RESTART_NOTICE_AFTER_MS = 1000
/** Answers of a process that is up but not serving yet (a gateway in front of it, a boot): safe to repeat with a key. */
const RESTART_STATUS = new Set([502, 503, 504])

const pause = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve()
    const done = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
  })

/** The fetch error codes that prove no byte of the request left; a reset or a lost answer is not among them. */
const NOTHING_SENT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ConnectionRefused'])

/** The host's LaunchAgent label: the name `scripts/deploy.sh` marks its deliberate restarts under. */
const HOST_LABEL = 'com.jkrumm.agent-workflows-host'

/** A hang guard on another process's contract fetch: it is a plain document, and a hung process must not stall host commands. */
const CONTRACT_FETCH_S = 10

/**
 * One platform process as the CLI sees it (the host, or a process named in `AGW_PROCESSES`): credentials, the
 * cached OpenAPI document and its contract sha, and one request per command with the contract header on every call.
 */
export class Host {
  #caller: Record<string, string> | undefined
  #creds: Credentials | undefined
  #doc: Document | undefined
  #commands: Command[] = []
  #skipped: Skipped[] = []
  #hidden: Hidden[] = []
  #sha = ''
  #refreshed = false
  #waitedMs = 0

  /**
   * `target` is a process from `AGW_PROCESSES`; without one this is the host at `AGW_URL`. `shared` hands over the
   * credentials the platform already read, so the env file is read and the process list validated once per call.
   * `notice` receives the one line a long restart wait prints.
   */
  constructor(
    readonly env: Env,
    private readonly target?: ProcessTarget,
    private readonly shared?: () => Credentials,
    private readonly notice?: (text: string) => void,
  ) {}

  /** Milliseconds this call spent waiting out a restart since the last time it was asked; the caller's own budget does not pay for them. */
  takeWaitedMs(): number {
    const waited = this.#waitedMs
    this.#waitedMs = 0
    return waited
  }

  get name(): string {
    return this.target?.name ?? HOST_PROCESS
  }

  get commands(): Command[] {
    return this.#commands
  }

  /** Operations in the document the CLI could not turn into a command, with the reason. */
  get skipped(): Skipped[] {
    return this.#skipped
  }

  /** Operations the document marks `x-cli.hidden`: no command, by design. */
  get hidden(): Hidden[] {
    return this.#hidden
  }

  get sha(): string {
    return this.#sha
  }

  get document(): Document | undefined {
    return this.#doc
  }

  /** Whether this invocation already fetched the document: every trigger refreshes at most once. */
  get refreshed(): boolean {
    return this.#refreshed
  }

  get url(): string {
    return this.target?.url ?? this.creds().url
  }

  /** How messages name this process: the host keeps the words it always had. */
  private get label(): string {
    return this.target ? `process ${this.target.name}` : 'host'
  }

  private creds(): Credentials {
    this.#creds ??= this.shared ? this.shared() : credentials(this.env)
    return this.#creds
  }

  private use(doc: Document, { commands, skipped, hidden }: ReturnType<typeof buildCommands>): void {
    this.#commands = commands
    this.#skipped = skipped
    this.#hidden = hidden
    this.#doc = doc
    this.#sha = servedSha(doc)
  }

  /** The cached document only; never touches the network. */
  loadCache(): boolean {
    try {
      const doc = JSON.parse(readFileSync(cachePath(this.env, this.url), 'utf8')) as Document
      const built = doc && typeof doc === 'object' ? buildCommands(doc) : undefined
      if (!built?.commands.length) return false
      this.use(doc, built)
      return true
    } catch {
      return false
    }
  }

  async load(): Promise<void> {
    if (!this.loadCache()) await this.refresh()
  }

  /** Commands are built and checked before the cache is written: a bad document never replaces a good one. */
  async refresh(): Promise<void> {
    this.#refreshed = true
    const { body } = await this.send('GET', '/openapi.json', {
      contract: false,
      ...(this.target ? { deadlineS: CONTRACT_FETCH_S } : {}),
    })
    const doc = body as Document
    const built = doc && typeof doc === 'object' && !Array.isArray(doc) ? buildCommands(doc) : undefined
    if (!built?.commands.length) {
      throw new AgwError(
        'general',
        `${this.target ? `${this.label}: ` : ''}${this.url}/openapi.json has no usable x-cli operations; the cached contract is kept`,
      )
    }
    const path = cachePath(this.env, this.url)
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(doc))
    renameSync(tmp, path)
    this.use(doc, built)
  }

  call(command: Command, values: Record<string, unknown>, options: CallOptions = {}): Promise<Reply> {
    let path = command.path
    const query = new URLSearchParams()
    const body: Record<string, unknown> = {}
    for (const field of command.fields) {
      const value = values[field.name]
      if (value === undefined) continue
      const text = typeof value === 'string' ? value : JSON.stringify(value)
      if (field.in === 'path') path = path.replace(`{${field.name}}`, encodeURIComponent(text))
      else if (field.in === 'query') query.set(field.name, text)
      else body[field.name] = value
    }
    const qs = query.toString()
    return this.send(command.method, qs ? `${path}?${qs}` : path, {
      command,
      body: command.hasBody ? body : undefined,
      ...options,
    })
  }

  private async send(
    method: string,
    path: string,
    options: CallOptions & { body?: unknown; command?: Command; contract?: boolean; deadlineS?: number },
  ): Promise<Reply> {
    const creds = this.creds()
    const url = this.url
    assertSafeUrl(url, this.target ? `${this.label} (AGW_PROCESSES)` : undefined)
    const headers: Record<string, string> = {
      accept: 'application/json',
      authorization: `Bearer ${requireSecret(this.env, creds)}`,
    }
    if (options.contract !== false && this.#sha) headers['x-agw-contract'] = this.#sha
    if (options.body !== undefined) headers['content-type'] = 'application/json'
    const waitS = options.waitS === undefined ? undefined : Math.max(0, Math.min(MAX_WAIT_S, options.waitS))
    if (waitS !== undefined) headers.prefer = `wait=${waitS}`
    if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey
    if (this.env.AGW_PURPOSE) headers['x-agw-purpose'] = this.env.AGW_PURPOSE
    this.#caller ??= callerHeaders(this.env, process.cwd())
    Object.assign(headers, this.#caller)

    const deadlineS = options.deadlineS ?? (waitS === undefined ? timeoutS(this.env) : waitS + SLACK_S)
    // A contract fetch with its own deadline (another process's) never waits: a hung process must not stall host commands.
    const rides = options.rideRestart !== false && options.deadlineS === undefined
    const retriesLost = Boolean(options.idempotencyKey) || method === 'GET'
    let firstFailure: number | undefined // the bound counts from here, not from the request: a long run that is cut still gets its retries
    let bound: { boundMs: number; deploying: boolean } | undefined
    let noticed = false
    let mayHaveLanded = false // an earlier attempt was cut or got a 5xx: the request may have reached the process
    // A refused connection after an attempt that may have landed no longer proves nothing was sent.
    const giveUp = (error: unknown) =>
      mayHaveLanded && error instanceof Unreachable
        ? new LostAnswer('network', error.message, { hint: error.hint, details: error.details })
        : error
    for (let failures = 0; ; failures++) {
      try {
        return await this.attempt({ method, url, path, headers, options, deadlineS })
      } catch (error) {
        const refused = error instanceof Unreachable
        const status = error instanceof AgwError ? error.details.status : undefined
        const again =
          refused ||
          (retriesLost && (error instanceof LostAnswer || (typeof status === 'number' && RESTART_STATUS.has(status))))
        if (error instanceof LostAnswer || (typeof status === 'number' && status >= 500)) mayHaveLanded = true
        if (!rides || !again || options.signal?.aborted) throw giveUp(error)
        bound ??= (({ boundS, deploying }) => ({ boundMs: boundS * 1000, deploying }))(
          restartBoundS(this.env, this.target ? `com.jkrumm.agent-workflows-${this.target.name}` : HOST_LABEL),
        )
        firstFailure ??= Date.now()
        const elapsed = Date.now() - firstFailure
        const delay = Math.min(RESTART_BACKOFF_MS * 2 ** failures, RESTART_BACKOFF_MAX_MS)
        if (elapsed + delay > bound.boundMs) throw giveUp(error)
        if (!noticed && elapsed + delay > RESTART_NOTICE_AFTER_MS) {
          noticed = true
          this.notice?.(
            bound.deploying
              ? `${this.label} restarting, waiting\n`
              : `${this.label} unreachable, retrying for up to ${Math.round(bound.boundMs / 1000)}s\n`,
          )
        }
        await pause(delay, options.signal)
        this.#waitedMs += Date.now() - firstFailure - elapsed
      }
    }
  }

  /** One request and its answer: a transport failure or a non-2xx status is thrown as an {@link AgwError}. */
  private async attempt({
    method,
    url,
    path,
    headers,
    options,
    deadlineS,
  }: {
    method: string
    url: string
    path: string
    headers: Record<string, string>
    options: CallOptions & { body?: unknown; command?: Command }
    deadlineS: number
  }): Promise<Reply> {
    const timeout = AbortSignal.timeout(deadlineS * 1000)
    const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout
    let response: Response
    let text: string
    try {
      response = await fetch(`${url}${path}`, {
        method,
        headers,
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        signal,
      })
      text = await response.text()
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      const hint = `is the ${this.label} up? ${BIN} schema works offline from the cache`
      if (options.signal?.aborted) throw new AgwError('network', `request to ${url} interrupted`, { hint })
      if (timeout.aborted) throw new AgwError('network', `no answer from ${url} within ${deadlineS}s`, { hint })
      const message = `${this.label} unreachable at ${url}: ${reason}`
      const code = (error as { code?: unknown } | null)?.code
      if (typeof code === 'string' && NOTHING_SENT.has(code)) throw new Unreachable('network', message, { hint })
      throw new LostAnswer('network', message, { hint })
    }
    let body: unknown = text
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      // A non-JSON body passes through as text.
    }
    if (response.ok) return { status: response.status, body }

    const error = asRecord(body) as ErrorBody
    const code = typeof error.code === 'string' ? error.code : null
    const kind = kindForStatus(response.status, code)
    const message =
      typeof error.message === 'string'
        ? withFirstIssue(error.message, error.data)
        : `HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ''}`
    const retryAfter = response.headers.get('retry-after')
    throw new AgwError(kind, message, {
      code,
      hint: hintFor(kind, this.env, options.command, retryAfter),
      details: {
        status: response.status,
        ...asRecord(error.data),
        ...(retryAfter && Number.isFinite(Number(retryAfter)) ? { retryAfterS: Number(retryAfter) } : {}),
      },
    })
  }
}
