import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { delimiter, isAbsolute, join } from 'node:path'
import type { Logger } from '@agent-workflows/runtime'
import { createClient, type Endpoint } from './client.ts'
import { ATTRIBUTION_PLUGIN, buildServerConfig, gatewayFromEnv } from './config.ts'
import { DEFAULT_STATE_DIR } from './locations.ts'

type Env = Record<string, string | undefined>

/**
 * The build the host is verified against (README §Measured). A server reporting another version is refused.
 * `scripts/install-opencode-bin.sh` reads this line to install the same version (README §Pinned build).
 */
export const OPENCODE_VERSION = '2.0.32'

export type ServerOptions = {
  /** Default `~/.local/state/agent-workflows`; the server's data lives in `<stateDir>/opencode/`. */
  stateDir?: string
  /** The binary and any leading args. Default: `resolveOpencodeBinary(env)`, the real build by absolute path. */
  command?: string[]
  /** Loopback port. Default: the persisted one, else a free one picked at the first start and kept. */
  port?: number
  /** Where the gateway's address and door token and `OTEL_EXPORTER_OTLP_*` are read from. Default `process.env`. */
  env?: Env
  /** `OPENCODE_CONFIG_CONTENT`. Default `buildServerConfig()` with the plugin from `installPlugin`. */
  config?: Record<string, unknown>
  /** Liveness tick. Default 5 s. */
  livenessIntervalMs?: number
  /** `GET /api/info` hang guard per probe. Default 2 s (wedge report). */
  livenessTimeoutMs?: number
  /** Consecutive failed probes before a restart. Default 3. */
  failuresBeforeRestart?: number
  /** SIGTERM, then SIGKILL after this long. Default 5 s. */
  termGraceMs?: number
  /** A started server must answer `/api/info` within this long, else it is killed and started again. Default 60 s. */
  bootTimeoutMs?: number
  /**
   * Failed boots in a row (binary missing, port taken, boot timeout) after which a restart gives up and `ready()`
   * rejects with the last error, instead of blocking its callers forever. The liveness tick starts a fresh round.
   * Default 5 (about 30 s of backoff).
   */
  bootFailuresBeforeFail?: number
  expectedVersion?: string
  logger?: Logger
}

/**
 * `fingerprint` is the hash of the env and command the running server was started with (drift detection); `pid`
 * is the child this supervisor spawned, the only pid it ever signals or adopts.
 */
type Persisted = { port: number; password: string; fingerprint?: string; pid?: number }

/** A child process or an adopted server, addressed by pid. */
type Proc = { pid: number; alive: () => boolean; waitExit: (ms: number) => Promise<boolean> }

class VersionMismatch extends Error {
  override name = 'VersionMismatch'
}

class ForeignServer extends Error {
  override name = 'ForeignServer'
}

const consoleLogger: Logger = {
  warn: (message, meta) => console.warn(message, meta ?? ''),
  error: (message, meta) => console.error(message, meta ?? ''),
}

/**
 * The attribution plugin, copied into the server's root under a name taken from its content, and that copy's directory.
 * A release lives in a directory named by its sha: pointing the config there would change the launch fingerprint on every
 * deploy, restarting the server under its running sessions, and an adopted server would keep a path that pruning removes.
 * The copy moves only when the plugin does. Idempotent: built beside it and renamed into place, and a rename that finds
 * the directory there already, a concurrent start's, is fine.
 */
export function installPlugin(root: string): string {
  const files = ['package.json', 'server.js'].map((name) => ({
    name,
    content: readFileSync(join(ATTRIBUTION_PLUGIN, name)),
  }))
  const hash = createHash('sha256')
  for (const { name, content } of files) hash.update(name).update(content)
  const dir = join(root, 'plugins', `agw-attribution-${hash.digest('hex').slice(0, 16)}`)
  const tmp = `${dir}.tmp-${process.pid}`
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmp, { recursive: true })
  for (const { name, content } of files) writeFileSync(join(tmp, name), content)
  try {
    renameSync(tmp, dir)
  } catch (err) {
    // The copy is already there, from an earlier start or a concurrent one: same name, same content.
    rmSync(tmp, { recursive: true, force: true })
    if (!existsSync(dir)) throw err
  }
  return dir
}

/**
 * The server's complete environment, an explicit allow-list: the process basics, the server's own state roots, the
 * gateway's address and door token, and `OTEL_EXPORTER_OTLP_*` when set. Nothing else from the host's env (provider keys,
 * `AGW_API_SECRET`, `CLAUDE_*`, database URLs) reaches the server or a tool shell. The door token opens the gateway only.
 * `OTEL_EXPORTER_OTLP_HEADERS` is one of those variables: on the mini it carries the ClickStack ingest key, so that key is
 * in a shell-capable agent's reach, like the door token (README, "Accepted risk"). `HOME` is the server's own
 * (`<root>/home`), so no `~/.claude` or `~/.agents` file reaches an agent and a tool shell starts there; the binary is
 * spawned by absolute path, so no shim needs the user's home.
 */
export function serverEnv(input: { root: string; password: string; config: Record<string, unknown>; env?: Env }) {
  const env = input.env ?? process.env
  const gateway = gatewayFromEnv(env)
  const out: Record<string, string> = {
    PATH: env.PATH ?? '/usr/bin:/bin',
    HOME: join(input.root, 'home'),
    TMPDIR: env.TMPDIR ?? '/tmp',
    LANG: env.LANG ?? 'en_US.UTF-8',
    XDG_DATA_HOME: join(input.root, 'data'),
    XDG_CONFIG_HOME: join(input.root, 'config'),
    XDG_STATE_HOME: join(input.root, 'state'),
    XDG_CACHE_HOME: join(input.root, 'cache'),
    OPENCODE_DB: join(input.root, 'opencode.db'),
    // The wedge fix: no per-ancestor file-watcher boot (docs/spikes/opencode-wedge/REPORT.md).
    OPENCODE_DISABLE_FILEWATCHER: '1',
    OPENCODE_DISABLE_CLAUDE_CODE: '1',
    OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_SERVER_PASSWORD: input.password,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(input.config),
    AGW_GATEWAY_URL: gateway.url,
    AGW_GATEWAY_TOOL_TOKEN: gateway.token,
  }
  for (const [name, value] of Object.entries(env)) {
    if (name.startsWith('OTEL_EXPORTER_OTLP_') && value) out[name] = value
  }
  return out
}

/**
 * Supervises one `opencode serve` on loopback. The server is spawned detached, so a host restart (deploy) leaves
 * it and its running sessions alone; the next host adopts it from `server.json` (port, password) after
 * `GET /api/info` proves the password and the version. Liveness: `GET /api/info` with a 2 s guard every tick; after
 * `failuresBeforeRestart` misses, or when the child exits, SIGTERM, grace, SIGKILL, and a fresh server on the same
 * port and data dir. Sessions survive in the sqlite store; waits re-attach by session id. There is no turn or
 * wall-clock cap anywhere: the runtime's idle timeout is the only stop for a session.
 */
export class OpenCodeServer {
  readonly root: string
  private command: string[] | null
  private readonly env: Env
  private readonly logger: Logger
  private readonly opts: Required<
    Pick<
      ServerOptions,
      | 'livenessIntervalMs'
      | 'livenessTimeoutMs'
      | 'failuresBeforeRestart'
      | 'termGraceMs'
      | 'bootTimeoutMs'
      | 'bootFailuresBeforeFail'
    >
  >
  private readonly expectedVersion: string
  private persisted: Persisted | null = null
  private proc: Proc | null = null
  private failures = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private restarting: Promise<void> | null = null
  private healthy = new Gate()
  private closed = false
  /** Aborted by `close()`: cuts a restart's backoff short. */
  private readonly shutdown = new AbortController()
  private config: Record<string, unknown> | null
  private restarts = 0
  private readonly restartListeners = new Set<() => void>()

  constructor(private readonly options: ServerOptions = {}) {
    this.root = join(options.stateDir ?? DEFAULT_STATE_DIR, 'opencode')
    this.env = options.env ?? process.env
    this.command = options.command ?? null
    this.logger = options.logger ?? consoleLogger
    this.config = options.config ?? null
    this.expectedVersion = options.expectedVersion ?? OPENCODE_VERSION
    this.opts = {
      livenessIntervalMs: options.livenessIntervalMs ?? 5_000,
      livenessTimeoutMs: options.livenessTimeoutMs ?? 2_000,
      failuresBeforeRestart: options.failuresBeforeRestart ?? 3,
      termGraceMs: options.termGraceMs ?? 5_000,
      bootTimeoutMs: options.bootTimeoutMs ?? 60_000,
      bootFailuresBeforeFail: options.bootFailuresBeforeFail ?? 5,
    }
  }

  /** Base URL and password; valid once `start()` resolved. */
  endpoint(): Endpoint {
    if (!this.persisted) throw new Error('opencode server not started')
    return { baseUrl: `http://127.0.0.1:${this.persisted.port}`, password: this.persisted.password }
  }

  get pid(): number | null {
    return this.proc?.pid ?? null
  }

  /** Called after every restart (liveness kill, crash): the new server holds no warm location. */
  onRestart(listener: () => void): void {
    this.restartListeners.add(listener)
  }

  /** Restarts since `start()` (liveness kills and crashes). */
  get restartCount(): number {
    return this.restarts
  }

  /**
   * Resolves while the server answers; during a restart, once it answers again. Rejects on `signal`, with the last
   * error when a restart gave up (`bootFailuresBeforeFail`), and once the supervisor is closed.
   */
  ready(signal?: AbortSignal): Promise<void> {
    const open = this.healthy.promise
    if (!signal) return open
    if (signal.aborted) return Promise.reject(signal.reason)
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(signal.reason)
      signal.addEventListener('abort', onAbort, { once: true })
      open.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
    })
  }

  async start(): Promise<void> {
    for (const dir of ['data', 'config', 'state', 'cache', 'home']) mkdirSync(join(this.root, dir), { recursive: true })
    this.persisted = await this.loadOrCreateState()
    if (!(await this.adopt())) await this.spawnAndBoot()
    this.healthy.open()
    this.timer = setInterval(() => void this.tick(), this.opts.livenessIntervalMs)
  }

  /** Stops supervising. `stop: true` also terminates the server (tests, uninstall); a deploy leaves it running. */
  async close(options: { stop?: boolean } = {}): Promise<void> {
    this.closed = true
    this.shutdown.abort()
    // A restart in its backoff must not reopen the gate behind this: whoever waits on the server is told it is gone.
    this.healthy.fail(new Error('opencode server supervisor is closed'))
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    await this.restarting?.catch(() => {})
    if (options.stop && this.proc) await this.terminate(this.proc)
  }

  /** Forces a restart now (tests, operator). */
  restart(reason: string): Promise<void> {
    if (this.restarting) return this.restarting
    if (this.closed) return Promise.resolve()
    this.healthy.close()
    const run = (async () => {
      this.logger.warn('opencode server restart', { reason, pid: this.proc?.pid ?? null })
      if (this.proc) await this.terminate(this.proc)
      this.proc = null
      let backoff = 1_000
      let failedBoots = 0
      while (!this.closed) {
        try {
          await this.spawnAndBoot()
          break
        } catch (err) {
          const message = (err as Error).message
          this.logger.error('opencode server failed to start', { error: message })
          if (++failedBoots >= this.opts.bootFailuresBeforeFail) {
            this.healthy.fail(new Error(`opencode server failed to start ${failedBoots} times in a row: ${message}`))
            this.failures = 0
            return
          }
          await sleepUnless(backoff, this.shutdown.signal)
          backoff = Math.min(backoff * 2, 30_000)
        }
      }
      // Closed meanwhile: `close()` has failed the gate, and nothing here reopens it.
      if (this.closed) return
      this.failures = 0
      this.restarts++
      for (const listener of this.restartListeners) listener()
      this.healthy.open()
    })().finally(() => {
      this.restarting = null
    })
    this.restarting = run
    return run
  }

  private async tick(): Promise<void> {
    if (this.closed || this.restarting) return
    if (await this.probe()) {
      this.failures = 0
      return
    }
    this.failures++
    this.logger.warn('opencode server liveness probe failed', { failures: this.failures })
    if (this.failures >= this.opts.failuresBeforeRestart) await this.restart('liveness')
  }

  /** `GET /api/info` within the liveness guard, from the right version and from our own process. */
  private async probe(pid = this.proc?.pid): Promise<boolean> {
    try {
      const info = await this.client().info({ timeoutMs: this.opts.livenessTimeoutMs })
      return info.version === this.expectedVersion && info.pid === pid
    } catch {
      return false
    }
  }

  private client() {
    return createClient(() => this.endpoint(), { requestTimeoutMs: this.opts.livenessTimeoutMs })
  }

  private statePath(): string {
    return join(this.root, 'server.json')
  }

  /** `server.json`; a corrupt file is an operator error with its path, never a boot loop. */
  private async loadOrCreateState(): Promise<Persisted> {
    const path = this.statePath()
    let state: Partial<Persisted> = {}
    if (existsSync(path)) {
      try {
        state = JSON.parse(readFileSync(path, 'utf8')) as Partial<Persisted>
        if (typeof state !== 'object' || state === null) throw new Error('not an object')
      } catch (err) {
        throw new Error(`${path} is corrupt (${(err as Error).message}); remove it to start a fresh server`)
      }
    }
    const next: Persisted = {
      port: this.options.port ?? state.port ?? (await freePort()),
      password: state.password ?? randomBytes(24).toString('base64url'),
      ...(state.fingerprint ? { fingerprint: state.fingerprint } : {}),
      ...(typeof state.pid === 'number' ? { pid: state.pid } : {}),
    }
    if (next.port !== state.port || next.password !== state.password) this.writeState(next)
    return next
  }

  /** Atomic and 0600: a temp file beside it, renamed over. */
  private writeState(state: Persisted): void {
    const path = this.statePath()
    const tmp = `${path}.tmp-${process.pid}`
    writeFileSync(tmp, `${JSON.stringify(state)}\n`, { mode: 0o600 })
    renameSync(tmp, path)
  }

  /** The command and env a spawn uses, and their fingerprint. */
  private launch(): { command: string[]; env: Record<string, string>; fingerprint: string } {
    const persisted = this.persisted as Persisted
    this.command ??= [resolveOpencodeBinary(this.env)]
    this.config ??= buildServerConfig({ plugin: installPlugin(this.root) })
    const env = serverEnv({ root: this.root, password: persisted.password, config: this.config, env: this.env })
    const sorted = Object.entries(env).sort(([a], [b]) => (a < b ? -1 : 1))
    const fingerprint = createHash('sha256')
      .update(JSON.stringify({ command: this.command, env: sorted }))
      .digest('hex')
    return { command: this.command, env, fingerprint }
  }

  /** A server from an earlier host process on our port, with our password and the pinned version. */
  private async adopt(): Promise<boolean> {
    const persisted = this.persisted
    if (!persisted) throw new Error('opencode server state not loaded')
    const info = await this.client()
      .info({ timeoutMs: this.opts.livenessTimeoutMs })
      .catch(() => null)
    const recorded = persisted.pid
    if (!info) {
      // Nothing answers. A child we spawned that never finished booting may still hold the port: recognised by the
      // recorded pid AND its own command line (pid reuse), it is terminated before a new spawn.
      if (recorded !== undefined && isOurServer(recorded, persisted.port)) {
        this.logger.warn('opencode server from server.json is alive but not answering; terminating it', {
          pid: recorded,
        })
        await this.terminate(adoptedProc(recorded))
      }
      return false
    }
    // The pid comes from server.json, written when this supervisor spawned the child; an HTTP answer alone is never
    // a reason to signal a process.
    if (recorded === undefined || info.pid !== recorded) {
      throw new ForeignServer(
        `a server answers on port ${persisted.port} with pid ${info.pid}, but ${this.statePath()} records ` +
          `${recorded ?? 'no pid'}; it is not ours to adopt or signal: stop it, or remove the file`,
      )
    }
    if (info.version !== this.expectedVersion) {
      throw new VersionMismatch(
        `opencode server on port ${persisted.port} is ${info.version}, need ${this.expectedVersion}`,
      )
    }
    const proc = adoptedProc(recorded)
    const { fingerprint } = this.launch()
    if (persisted.fingerprint !== fingerprint) {
      // A deploy changed the server's env or config (routes, rates, key, binary): the running server is stale.
      this.logger.warn('opencode server env or config changed since it started; restarting it', { pid: recorded })
      await this.terminate(proc)
      return false
    }
    this.proc = proc
    return true
  }

  private async spawnAndBoot(): Promise<void> {
    const persisted = this.persisted as Persisted
    const { command, env, fingerprint } = this.launch()
    if (persisted.fingerprint !== fingerprint) {
      persisted.fingerprint = fingerprint
      this.writeState(persisted)
    }
    const log = openSync(join(this.root, 'server.log'), 'a')
    const [bin, ...lead] = command as [string, ...string[]]
    const child = spawn(bin, [...lead, 'serve', '--hostname', '127.0.0.1', '--port', String(persisted.port)], {
      cwd: this.root,
      env,
      detached: true,
      stdio: ['ignore', log, log],
    })
    closeSync(log)
    child.unref()
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    const spawnError = new Promise<never>((_, reject) => child.once('error', reject))
    spawnError.catch(() => {})
    if (child.pid === undefined) await spawnError
    let alive = true
    void exited.then(() => {
      alive = false
    })
    const proc: Proc = {
      pid: child.pid as number,
      alive: () => alive,
      waitExit: (ms) => Promise.race([exited.then(() => true), Bun.sleep(ms).then(() => false)]),
    }
    this.proc = proc
    // Recorded at once, so a child that never boots is still known as ours to the next start.
    persisted.pid = proc.pid
    this.writeState(persisted)
    let booted = false
    void exited.then(() => {
      if (!booted || this.closed || this.proc !== proc || this.restarting) return
      void this.restart('server exited')
    })
    const deadline = Date.now() + this.opts.bootTimeoutMs
    while (Date.now() < deadline) {
      if (!proc.alive()) throw new Error(`opencode server exited during boot (see ${join(this.root, 'server.log')})`)
      // Only an answer from the child we spawned counts: another process on the port is not our server.
      if ((await this.probe(proc.pid)) && proc.alive()) {
        booted = true
        return
      }
      await Bun.sleep(100)
    }
    await this.terminate(proc)
    throw new Error(`opencode server did not answer within ${this.opts.bootTimeoutMs} ms`)
  }

  /** SIGTERM, wait up to the grace, SIGKILL. A server in a boot stall ignores SIGTERM (wedge report). */
  private async terminate(proc: Proc): Promise<void> {
    if (!proc.alive()) return
    signal(proc.pid, 'SIGTERM')
    if (await proc.waitExit(this.opts.termGraceMs)) return
    this.logger.warn('opencode server ignored SIGTERM, sending SIGKILL', { pid: proc.pid })
    signal(proc.pid, 'SIGKILL')
    await proc.waitExit(2_000)
  }
}

/**
 * The real `opencode` build by absolute path: `AGW_OPENCODE_BIN`, else `opencode` on PATH. A shell shim (the
 * machine's `~/.local/bin/opencode` execs the pinned build through `bin="$HOME/…"`) is followed to its target, so
 * the server never needs the user's `HOME` to start.
 */
export function resolveOpencodeBinary(env: Env = process.env): string {
  const explicit = env.AGW_OPENCODE_BIN
  const found =
    explicit ??
    (env.PATH ?? '')
      .split(delimiter)
      .map((dir) => join(dir, 'opencode'))
      .find((path) => isExecutable(path))
  if (!found) throw new Error('opencode not found: set AGW_OPENCODE_BIN or put opencode on PATH')
  const path = realpathSync(found)
  const head = readFileSync(path).subarray(0, 2).toString()
  if (head !== '#!') return path
  const script = readFileSync(path, 'utf8')
  const target = /^\s*bin="([^"]+)"/m.exec(script)?.[1]?.replaceAll(/\$\{?HOME\}?/g, env.HOME ?? '')
  if (!target || !isAbsolute(target) || !isExecutable(target)) {
    throw new Error(`${path} is a script whose target cannot be resolved; set AGW_OPENCODE_BIN to the real binary`)
  }
  return realpathSync(target)
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function signal(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(pid, sig)
  } catch {
    // already gone
  }
}

/** The process is alive and is an `opencode serve` on our port (its command line, via `ps`). */
function isOurServer(pid: number, port: number): boolean {
  const ps = Bun.spawnSync(['ps', '-o', 'command=', '-p', String(pid)])
  if (ps.exitCode !== 0) return false
  return isServeOnPort(ps.stdout.toString(), port)
}

/**
 * A command line is `… serve … --port <port>` (or `--port=<port>`), compared token by token: port 4096 never
 * matches `--port 40960`, and `serve` must be its own argument.
 */
export function isServeOnPort(command: string, port: number): boolean {
  const argv = command.trim().split(/\s+/)
  if (!argv.includes('serve')) return false
  const want = String(port)
  return argv.some((arg, i) => (arg === '--port' && argv[i + 1] === want) || arg === `--port=${want}`)
}

function adoptedProc(pid: number): Proc {
  const alive = () => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  const waitExit = async (ms: number) => {
    const deadline = Date.now() + ms
    while (alive() && Date.now() < deadline) await Bun.sleep(50)
    return !alive()
  }
  return { pid, alive, waitExit }
}

/**
 * Open: `promise` is resolved. Closed: a fresh pending promise until the next `open()` or `fail()`. Failed: `promise`
 * is rejected and stays so until `close()` makes it pending again; `open()` does not undo a failure.
 */
class Gate {
  promise: Promise<void> = Promise.resolve()
  /** Set while the promise is pending. */
  private pending: { resolve: () => void; reject: (error: Error) => void } | null = null

  constructor() {
    this.close()
  }

  open(): void {
    const pending = this.pending
    this.pending = null
    pending?.resolve()
  }

  close(): void {
    if (this.pending) return
    this.promise = new Promise((resolve, reject) => {
      this.pending = { resolve, reject }
    })
  }

  fail(error: Error): void {
    const pending = this.pending
    this.pending = null
    if (pending) {
      pending.reject(error)
    } else {
      this.promise = Promise.reject(error)
    }
    // Waiters get the error; a gate nobody waits on is not an unhandled rejection.
    this.promise.catch(() => {})
  }
}

/** Resolves after `ms`, or at once when `signal` aborts. */
function sleepUnless(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address()
      srv.close(() => (typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no port'))))
    })
  })
}
