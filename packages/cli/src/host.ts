import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
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
  timeoutS,
} from './config.ts'
import { AgwError, kindForStatus } from './exit.ts'
import { buildCommands, type Command, type Document, type Hidden, type Skipped, servedSha } from './spec.ts'

/** The host waits at most this long per request (Bun's `idleTimeout` ceiling is 255 s). */
export const MAX_WAIT_S = 240
/** Added to a wait request's `Prefer: wait`, so the host answers before the client gives up. */
const SLACK_S = 30

export interface Reply {
  status: number
  body: unknown
}

export interface CallOptions {
  waitS?: number
  idempotencyKey?: string
}

interface ErrorBody {
  code?: unknown
  message?: unknown
  data?: unknown
}

const asRecord = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}

function hintFor(kind: AgwError['kind'], env: Env, command: Command | undefined, retryAfter: string | null): string {
  if (kind === 'auth') return `check AGW_API_SECRET (environment or ${envFilePath(env)})`
  if (kind === 'contract_mismatch') return `${BIN} schema --refresh`
  if (kind === 'rate_limited') return retryAfter ? `retry after ${retryAfter}s` : 'retry later'
  if (kind === 'usage' && command) return `${BIN} ${command.words.join(' ')} --help`
  return ''
}

/** The connection was never opened (refused, no such name): nothing reached the process, so another may be asked. */
export class Unreachable extends AgwError {}

/** The fetch error codes that prove no byte of the request left; a reset or a lost answer is not among them. */
const NOTHING_SENT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ConnectionRefused'])

/** A hang guard on another process's contract fetch: it is a plain document, and a hung process must not stall host commands. */
const CONTRACT_FETCH_S = 10

/**
 * One platform process as the CLI sees it (the host, or a process named in `AGW_PROCESSES`): credentials, the
 * cached OpenAPI document and its contract sha, and one request per command with the contract header on every call.
 */
export class Host {
  #creds: Credentials | undefined
  #doc: Document | undefined
  #commands: Command[] = []
  #skipped: Skipped[] = []
  #hidden: Hidden[] = []
  #sha = ''
  #refreshed = false

  /**
   * `target` is a process from `AGW_PROCESSES`; without one this is the host at `AGW_URL`. `shared` hands over the
   * credentials the platform already read, so the env file is read and the process list validated once per call.
   */
  constructor(
    readonly env: Env,
    private readonly target?: ProcessTarget,
    private readonly shared?: () => Credentials,
  ) {}

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

    const deadlineS = options.deadlineS ?? (waitS === undefined ? timeoutS(this.env) : waitS + SLACK_S)
    const signal = AbortSignal.timeout(deadlineS * 1000)
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
      if (signal.aborted) throw new AgwError('network', `no answer from ${url} within ${deadlineS}s`, { hint })
      const message = `${this.label} unreachable at ${url}: ${reason}`
      const code = (error as { code?: unknown } | null)?.code
      if (typeof code === 'string' && NOTHING_SENT.has(code)) throw new Unreachable('network', message, { hint })
      throw new AgwError('network', message, { hint })
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
        ? error.message
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
