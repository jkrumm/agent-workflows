import { randomUUID } from 'node:crypto'
import { assertValues, BIN, coerceStdin, helpText, type Parsed, parseArgs, unsafePathField, usageLine } from './args.ts'
import { type Env, waitBudgetS } from './config.ts'
import { AgwError, EXIT, EXIT_MEANING, type ExitKind, usage } from './exit.ts'
import { type Host, MAX_WAIT_S, type Reply } from './host.ts'
import { Platform } from './platform.ts'
import { type Command, nextWords, resolveCommand, type Schema, waitPlan } from './spec.ts'

export interface Io {
  env: Env
  stdinIsTTY: boolean
  stdoutIsTTY: boolean
  readStdin: () => Promise<string>
  out: (text: string) => void
  err: (text: string) => void
}

interface RunState {
  runId?: unknown
  status?: unknown
  error?: { kind?: unknown; message?: unknown }
  [key: string]: unknown
}

const SCHEMA_HELP = `usage: ${BIN} schema [command…] [--refresh] [--exit-codes] [--format json|plain]

Offline: reads the cached contract; fetches one only when there is none.
  ${BIN} schema                 every command, the contract sha, and skipped operations with their reason
  ${BIN} schema <command…>      that operation's input schema, output schema and x-cli
  --refresh                 fetch the host's contract first
  --exit-codes              the exit-code table; needs neither a cache nor a host
`

const TERMINAL = new Set(['done', 'failed', 'cancelled'])

interface Call {
  command: Command
  parsed: Parsed
  values: Record<string, unknown>
}

/** A 412 on the first request of a command: nothing ran, so refresh and retry once is safe. */
class StaleContract extends Error {
  constructor(
    readonly mismatch: AgwError,
    readonly command: Command,
  ) {
    super(mismatch.message)
  }
}

/** A usage error a stale cache explains, when the refresh that would have settled it failed: the reason is in the message. */
const unrefreshed = (error: AgwError, refresh: string) =>
  new AgwError('usage', `${error.message} (the cached contract could not be refreshed: ${refresh})`, {
    hint: error.hint,
    details: { ...error.details, refresh },
  })

/** `-h` or `--help` among the arguments (not after `--`): the same rule `parseArgs` applies. */
const wantsHelp = (argv: string[]) => {
  const end = argv.indexOf('--')
  return (end < 0 ? argv : argv.slice(0, end)).some((word) => word === '-h' || word === '--help')
}

const shellWord = (word: string) => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`)

function dig(value: unknown, path: string): unknown {
  let node = value
  for (const key of path.split('.')) {
    node = node !== null && typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined
  }
  return node
}

/**
 * `--format plain` prints `x-cli.plainField`, a dotted path. A capability answers its output directly, so the path starts
 * at the response. A workflow answers a run envelope (`runId`, `status`, `output`, ...) and its path starts at `.output`,
 * but only once the run is done: a pending, failed or cancelled answer has no output to print, and keeps the whole state.
 */
function render(body: unknown, format: 'json' | 'plain', command: Command): string {
  if (format === 'json') return JSON.stringify(body)
  const done = (body as { status?: unknown } | null)?.status === 'done'
  const root = command.x.kind === 'workflow' && done ? (body as { output?: unknown }).output : body
  const field = command.x.plainField ? dig(root, command.x.plainField) : undefined
  if (typeof field === 'string') return field
  return JSON.stringify(field ?? body, null, 2)
}

class Runner {
  readonly platform: Platform
  #stdin: Promise<string> | undefined
  #key: string | undefined

  constructor(readonly io: Io) {
    this.platform = new Platform(io.env)
  }

  private get host(): Host {
    return this.platform.host
  }

  private stdin(): Promise<string> {
    this.#stdin ??= this.io.readStdin()
    return this.#stdin
  }

  async dispatch(argv: string[]): Promise<number> {
    const [first, ...rest] = argv
    if (first === 'schema') return this.schema(rest)
    if (first === undefined || first === '--help' || first === '-h') return this.topHelp()

    await this.platform.load()
    // Help is printed from the contract and sends no request, so no `x-agw-contract` check can tell that the cache is
    // stale (a command added, a flag added or dropped since it was written): ask every process first, keep a cache if
    // its process cannot answer. Every other command carries the sha, and a stale one is a 412 that refreshes and retries.
    if (wantsHelp(argv)) await this.freshen()
    const call = await this.prepareFresh(argv)
    this.platform.assertNoConflict(call.command)
    if (call.parsed.globals.help) {
      this.io.out(helpText(call.command))
      const down = this.unavailable(call.command)
      if (down) this.io.out(`\n(${down})\n`)
      return EXIT.ok
    }
    try {
      return await this.execute(call)
    } catch (error) {
      if (!(error instanceof StaleContract)) throw error
      return this.retryAfterMismatch(argv, error)
    }
  }

  /** Fetches each contract once per call; a process that cannot answer (down, no secret) leaves its cached one in use. */
  private async freshen(): Promise<void> {
    await this.platform.freshen()
  }

  /** Why the process that declares this command could not be asked for its contract, when it is not the host. */
  private unavailable(command: Command): string | undefined {
    const owners = this.platform.owners(command).filter((d) => d.host !== this.host)
    const down = owners.filter((d) => this.platform.failure(d.host) !== undefined)
    if (!down.length || down.length < this.platform.owners(command).length) return undefined
    return down.map((d) => `unavailable: ${this.platform.failure(d.host)}`).join('; ')
  }

  /** argv → command and input values. Every check here runs before anything is sent. */
  private async prepare(argv: string[]): Promise<Call> {
    const hit = resolveCommand(this.platform.commands, argv)
    if (!hit) throw this.unknownCommand(argv)
    const { command } = hit
    const parsed = parseArgs(command, hit.rest)
    const values = { ...parsed.values }
    if (parsed.globals.help) return { command, parsed, values }
    // Only a required field is read implicitly: an inherited open pipe must not hang an optional one.
    const stdinField = command.fields.find((f) => f.name === command.x.stdin)
    if (stdinField?.required && values[stdinField.name] === undefined && !this.io.stdinIsTTY) {
      const text = await this.stdin()
      if (text !== '') values[stdinField.name] = coerceStdin(command, text)
    }
    assertValues(command, values)
    return { command, parsed, values }
  }

  /**
   * A stale cache explains any usage error (a new command, a new flag, a newly required field), so
   * the first one refreshes the document once and parses again.
   */
  private async prepareFresh(argv: string[]): Promise<Call> {
    try {
      return await this.prepare(argv)
    } catch (error) {
      if (!(error instanceof AgwError) || !error.stale) throw error
      // Already fetched this call (a help call, or no cache to start with): nothing more to try, unless that failed.
      if (this.platform.allRefreshed) {
        const why = this.platform.failures()
        throw why ? unrefreshed(error, why) : error
      }
      try {
        await this.platform.refreshAll()
      } catch (refreshError) {
        throw unrefreshed(error, refreshError instanceof Error ? refreshError.message : String(refreshError))
      }
      try {
        return await this.prepare(argv)
      } catch (again) {
        const why = this.platform.failures()
        if (!(again instanceof AgwError) || !again.stale || !why) throw again
        throw unrefreshed(again, why)
      }
    }
  }

  private async retryAfterMismatch(argv: string[], stale: StaleContract): Promise<number> {
    const { mismatch } = stale
    await this.platform.refreshOwners(stale.command)
    let call: Call
    try {
      call = await this.prepare(argv)
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error)
      throw new AgwError('contract_mismatch', `${mismatch.message}; on the host's contract: ${why}`, {
        code: mismatch.code,
        hint: `${BIN} schema lists the host's commands`,
        details: mismatch.details,
      })
    }
    this.platform.assertNoConflict(call.command)
    try {
      return await this.execute(call)
    } catch (error) {
      if (error instanceof StaleContract) throw error.mismatch
      throw error
    }
  }

  private unknownCommand(argv: string[]): AgwError {
    const { prefix, options } = nextWords(this.platform.commands, argv)
    const words = argv.filter((w) => !w.startsWith('-'))
    const message =
      prefix.length === words.length
        ? `incomplete command '${words.join(' ')}'`
        : `unknown command '${words.join(' ')}'`
    const hint = options.length
      ? `${[BIN, ...prefix].join(' ')} ${options.join('|')}`
      : `${BIN} schema lists the commands`
    return new AgwError('usage', message, { hint, stale: true })
  }

  private async execute({ command, parsed, values }: Call): Promise<number> {
    const { io } = this
    if (command.x.mutating && !parsed.globals.commit && !io.stdinIsTTY) {
      throw new AgwError('confirmation_required', `${command.words.join(' ')} changes state; nothing was sent`, {
        hint: `re-run with --commit: ${usageLine(command)}`,
      })
    }
    // A start or a mutation may land even when its answer is lost: it always carries a key, so a retry is safe.
    const startsWork = command.x.kind === 'workflow' || command.x.mutating
    if (startsWork) this.#key ??= parsed.globals.idempotencyKey ?? randomUUID()
    const format = parsed.globals.format ?? (io.stdoutIsTTY ? command.x.defaultFormat : 'json')
    const emit = (body: unknown) => io.out(`${render(body, format, command)}\n`)
    const plan = waitPlan(this.platform.commands, command)
    const budgetS = waitBudgetS(io.env)
    const deadline = Date.now() + budgetS * 1000

    let reply: Reply
    // The process that answered the start: the wait loop stays on it, so a run is followed where it was started.
    let owner: Host
    try {
      ;({ reply, host: owner } = await this.platform.call(command, values, {
        ...(startsWork ? { idempotencyKey: this.#key } : {}),
        ...(plan ? { waitS: Math.floor(budgetS) } : {}),
      }))
    } catch (error) {
      if (!(error instanceof AgwError)) throw error
      if (error.kind === 'contract_mismatch') throw new StaleContract(error, command)
      if (error.kind === 'network' && startsWork) {
        throw new AgwError('network', error.message, {
          hint: `the run may have started; retry with --idempotency-key ${this.#key}`,
          details: { idempotencyKey: this.#key },
        })
      }
      throw error
    }
    if (!plan) {
      emit(reply.body)
      return EXIT.ok
    }

    let state = (reply.body ?? {}) as RunState
    const resume = plan.resume
    const resumeCommand = resume && owner.commands.find((c) => c.words.join(' ') === resume.command.join(' '))
    const resumeValues = Object.fromEntries((resume?.positional ?? []).map((name) => [name, state[name]]))
    const usable = (v: unknown) => (typeof v === 'string' && v !== '') || typeof v === 'number'
    if (
      reply.status === 202 &&
      (!resumeCommand || !resume?.positional.length || !Object.values(resumeValues).every(usable))
    ) {
      emit(state)
      throw new AgwError(
        'general',
        resumeCommand ? 'host returned no run id' : `host declared no resume command for ${command.words.join(' ')}`,
        {
          details: { status: reply.status },
        },
      )
    }
    // The resume values come from the host's reply: they get the same path check as argv, before any request.
    const unsafe = reply.status === 202 && resumeCommand ? unsafePathField(resumeCommand, resumeValues) : undefined
    if (unsafe) {
      emit(state)
      throw new AgwError('general', `host returned an unsafe ${unsafe.name}: ${String(resumeValues[unsafe.name])}`, {
        details: { status: reply.status, [unsafe.name]: resumeValues[unsafe.name] },
      })
    }
    const resumeLine = [
      BIN,
      ...(resume?.command ?? []),
      ...Object.values(resumeValues).map((v) => shellWord(String(v))),
    ].join(' ')
    if (resumeCommand)
      ({ reply, state } = await this.poll({ owner, reply, state, resumeCommand, resumeValues, resumeLine, deadline }))

    emit(state)
    const status = String(state.status)
    if (reply.status === 202 || !TERMINAL.has(status)) {
      throw new AgwError('pending', `run ${String(state.runId)} still ${status} after ${budgetS}s`, {
        hint: resumeLine,
        details: { runId: state.runId, status, budgetS },
      })
    }
    if (status === 'done') return EXIT.ok
    const reason = typeof state.error?.message === 'string' ? `: ${state.error.message}` : ''
    throw new AgwError('general', `run ${String(state.runId)} ${status}${reason}`, {
      details: { runId: state.runId, status, ...(state.error?.kind ? { errorKind: state.error.kind } : {}) },
    })
  }

  /** Loops the resume command while the host answers 202, until the run ends or the deadline passes. */
  private async poll(loop: {
    owner: Host
    reply: Reply
    state: RunState
    resumeCommand: Command
    resumeValues: Record<string, unknown>
    resumeLine: string
    deadline: number
  }): Promise<{ reply: Reply; state: RunState }> {
    let { reply, state } = loop
    while (reply.status === 202) {
      const leftS = Math.floor((loop.deadline - Date.now()) / 1000)
      if (leftS < 1) break
      const started = Date.now()
      try {
        reply = await loop.owner.call(loop.resumeCommand, loop.resumeValues, { waitS: Math.min(leftS, MAX_WAIT_S) })
      } catch (error) {
        throw await this.resumable(error, loop.owner, loop.resumeLine)
      }
      state = (reply.body ?? {}) as RunState
      // A host that answers 202 at once must not be hammered.
      if (reply.status === 202) await Bun.sleep(Math.max(0, 1000 - (Date.now() - started)))
    }
    return { reply, state }
  }

  /** A failure mid-wait: the run keeps going server-side, so the hint is the resume command. */
  private async resumable(error: unknown, owner: Host, resumeLine: string): Promise<unknown> {
    if (!(error instanceof AgwError) || !resumeLine) return error
    if (error.kind === 'contract_mismatch') await owner.refresh().catch(() => undefined)
    if (error.kind !== 'network' && error.kind !== 'contract_mismatch') return error
    return new AgwError(error.kind, error.message, { code: error.code, hint: resumeLine, details: error.details })
  }

  private async topHelp(): Promise<number> {
    for (const p of this.platform.processes) p.loadCache()
    await this.freshen()
    const commands = this.platform.commands
    const lines = [
      `${BIN} <command> [args] [--help]    ${BIN} schema [command…] [--refresh] [--exit-codes]`,
      '',
      ...commands.map((c) => `  ${usageLine(c)}${this.marker(c)}`),
    ]
    if (!commands.length) lines.push(`  (no cached contract; ${BIN} schema --refresh fetches it)`)
    for (const p of this.platform.secondaries) {
      const why = this.platform.failure(p)
      if (why !== undefined) lines.push(`  (unavailable: ${why})`)
    }
    this.io.out(`${lines.join('\n')}\n`)
    return EXIT.ok
  }

  /** In the command list: a command no reachable process can serve, or one two processes claim. */
  private marker(command: Command): string {
    const conflict = this.platform.conflict(command)
    if (conflict) return `    [conflict: ${conflict.join(', ')}]`
    const owners = this.platform.owners(command)
    if (owners.some((d) => d.host === this.host)) return ''
    if (owners.every((d) => this.platform.failure(d.host) !== undefined))
      return `    [unavailable: ${owners.map((d) => d.host.name).join(', ')}]`
    return ''
  }

  private async schema(tokens: string[]): Promise<number> {
    const words: string[] = []
    let refresh = false
    let exitCodes = false
    let format: 'json' | 'plain' = 'json'
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i] as string
      if (token === '--help' || token === '-h') {
        this.io.out(SCHEMA_HELP)
        return EXIT.ok
      } else if (token === '--refresh') refresh = true
      else if (token === '--exit-codes') exitCodes = true
      else if (token === '--format' || token.startsWith('--format=')) {
        const value = token.includes('=') ? token.slice(9) : tokens[++i]
        if (value !== 'json' && value !== 'plain') throw usage(`--format must be json or plain, got: ${value}`)
        format = value
      } else if (token.startsWith('-'))
        throw usage(`unknown flag ${token}`, 'valid flags: --refresh --exit-codes --format --help')
      else words.push(token)
    }
    const print = (value: unknown) =>
      this.io.out(`${format === 'plain' ? JSON.stringify(value, null, 2) : JSON.stringify(value)}\n`)

    if (exitCodes) {
      const table = (Object.keys(EXIT) as ExitKind[]).map((kind) => ({
        code: EXIT[kind],
        kind,
        meaning: EXIT_MEANING[kind],
      }))
      if (format === 'plain') this.io.out(`${table.map((r) => `${r.code}\t${r.kind}\t${r.meaning}`).join('\n')}\n`)
      else print({ exitCodes: table })
      return EXIT.ok
    }
    if (refresh) await this.platform.refreshAll()
    else await this.platform.load()

    const { multi } = this.platform
    // With one process the output is what it always was; with more, every entry names its process.
    const named = (host: Host) => (multi ? { process: host.name } : {})
    const declarations = this.platform.declarations()
    if (!words.length) {
      const skipped = this.platform.processes.flatMap((p) => p.skipped.map((s) => ({ ...named(p), ...s })))
      const conflicts = this.platform.commands.flatMap((c) => {
        const processes = this.platform.conflict(c)
        return processes ? [{ command: c.words.join(' '), processes }] : []
      })
      print({
        contractSha: this.host.sha,
        ...(multi
          ? {
              processes: this.platform.processes.map((p) => ({
                process: p.name,
                url: p.url,
                contractSha: p.sha,
                ...(this.platform.failure(p) === undefined ? {} : { unavailable: this.platform.failure(p) }),
              })),
            }
          : {}),
        ...(skipped.length ? { skipped } : {}),
        ...(conflicts.length ? { conflicts } : {}),
        commands: declarations.map(({ host, command: c }) => ({
          ...named(host),
          command: c.words.join(' '),
          kind: c.x.kind,
          mutating: c.x.mutating,
          summary: c.summary,
          usage: usageLine(c),
        })),
      })
      return EXIT.ok
    }
    const exact = declarations.filter((d) => d.command.words.join(' ') === words.join(' '))
    if (exact.length === 1 && exact[0]) {
      print(this.describe(exact[0].command, exact[0].host))
      return EXIT.ok
    }
    // The same command from more than one process: every declaration, each naming its process.
    if (exact.length) {
      print(exact.map((d) => this.describe(d.command, d.host)))
      return EXIT.ok
    }
    const below = declarations.filter((d) => words.every((w, i) => d.command.words[i] === w))
    if (!below.length) {
      const { prefix, options } = nextWords(this.platform.commands, words)
      throw usage(
        `unknown command '${words.join(' ')}'`,
        options.length ? `${[BIN, 'schema', ...prefix].join(' ')} ${options.join('|')}` : `${BIN} schema`,
      )
    }
    print(below.map((d) => this.describe(d.command, d.host)))
    return EXIT.ok
  }

  private describe(command: Command, host: Host) {
    const properties: Record<string, Schema> = {}
    for (const f of command.fields) {
      const at = command.x.positional.indexOf(f.name)
      properties[f.name] = { ...f.schema, ...(at >= 0 ? { 'x-positional': at } : { 'x-flag': `--${f.flag}` }) }
    }
    return {
      ...(this.platform.multi ? { process: host.name } : {}),
      command: command.words.join(' '),
      kind: command.x.kind,
      summary: command.summary,
      usage: usageLine(command),
      contractSha: host.sha,
      input: { type: 'object', properties, required: command.fields.filter((f) => f.required).map((f) => f.name) },
      output: command.output,
      'x-cli': command.x,
    }
  }
}

/** Runs one `agw` invocation; every failure becomes one JSON line on stderr and its exit code. */
export async function run(argv: string[], io: Io): Promise<number> {
  try {
    return await new Runner(io).dispatch(argv)
  } catch (error) {
    const failure =
      error instanceof AgwError
        ? error
        : new AgwError('general', error instanceof Error ? error.message : String(error))
    io.err(`${failure.toErrorLine()}\n`)
    return failure.exitCode
  }
}
