import { assertRequired, BIN, coerceStdin, helpText, type Parsed, parseArgs, usageLine } from './args.ts'
import { type Env, waitBudgetS } from './config.ts'
import { AgwError, EXIT, EXIT_MEANING, type ExitKind, usage } from './exit.ts'
import { Host, MAX_WAIT_S, type Reply } from './host.ts'
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

const TERMINAL = new Set(['done', 'failed', 'cancelled'])

/** A 412 on the first request of a command: nothing ran, so refresh and retry once is safe. */
class StaleContract extends Error {
  constructor(readonly mismatch: AgwError) {
    super(mismatch.message)
  }
}

const shellWord = (word: string) => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`)

function dig(value: unknown, path: string): unknown {
  let node = value
  for (const key of path.split('.')) {
    node = node !== null && typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined
  }
  return node
}

function render(body: unknown, format: 'json' | 'plain', command: Command): string {
  if (format === 'json') return JSON.stringify(body)
  const field = command.x.plainField ? dig(body, command.x.plainField) : undefined
  if (typeof field === 'string') return field
  return JSON.stringify(field ?? body, null, 2)
}

class Runner {
  readonly host: Host
  #stdin: Promise<string> | undefined

  constructor(readonly io: Io) {
    this.host = new Host(io.env)
  }

  private stdin(): Promise<string> {
    this.#stdin ??= this.io.readStdin()
    return this.#stdin
  }

  async dispatch(argv: string[]): Promise<number> {
    const [first, ...rest] = argv
    if (first === 'schema') return this.schema(rest)
    if (first === undefined || first === '--help' || first === '-h') return this.topHelp()

    await this.host.load()
    let hit = resolveCommand(this.host.commands, argv)
    let refreshFailure: string | undefined
    if (!hit) {
      // A workflow deployed since the cache was written appears without a manual refresh.
      try {
        await this.host.refresh()
      } catch (error) {
        refreshFailure = error instanceof Error ? error.message : String(error)
      }
      hit = resolveCommand(this.host.commands, argv)
    }
    if (!hit) throw this.unknownCommand(argv, refreshFailure)

    const parsed = parseArgs(hit.command, hit.rest)
    if (parsed.globals.help) {
      this.io.out(helpText(hit.command))
      return EXIT.ok
    }
    try {
      return await this.execute(hit.command, parsed)
    } catch (error) {
      if (!(error instanceof StaleContract)) throw error
      return this.retryAfterMismatch(argv, error.mismatch)
    }
  }

  private async retryAfterMismatch(argv: string[], mismatch: AgwError): Promise<number> {
    await this.host.refresh()
    const hit = resolveCommand(this.host.commands, argv)
    const refused = (why: string) =>
      new AgwError('contract_mismatch', `${mismatch.message}; ${why}`, {
        code: mismatch.code,
        hint: `${BIN} schema lists the host's commands`,
        details: mismatch.details,
      })
    if (!hit)
      throw refused(`'${argv.filter((w) => !w.startsWith('-')).join(' ')}' is not a command on the host's contract`)
    let parsed: Parsed
    try {
      parsed = parseArgs(hit.command, hit.rest)
    } catch (error) {
      throw refused(`the command no longer parses: ${error instanceof Error ? error.message : String(error)}`)
    }
    try {
      return await this.execute(hit.command, parsed)
    } catch (error) {
      if (error instanceof StaleContract) throw error.mismatch
      throw error
    }
  }

  private unknownCommand(argv: string[], refreshFailure: string | undefined): AgwError {
    const { prefix, options } = nextWords(this.host.commands, argv)
    const words = argv.filter((w) => !w.startsWith('-'))
    const message =
      prefix.length === words.length
        ? `incomplete command '${words.join(' ')}'`
        : `unknown command '${words.join(' ')}'`
    const hint = options.length
      ? `${[BIN, ...prefix].join(' ')} ${options.join('|')}`
      : `${BIN} schema lists the commands`
    return new AgwError('usage', message, { hint, details: refreshFailure ? { refresh: refreshFailure } : {} })
  }

  private async execute(command: Command, parsed: Parsed): Promise<number> {
    const { io } = this
    const values = { ...parsed.values }
    const stdinName = command.x.stdin
    if (stdinName && values[stdinName] === undefined && !io.stdinIsTTY) {
      const text = await this.stdin()
      if (text !== '') values[stdinName] = coerceStdin(command, text)
    }
    assertRequired(command, values)
    if (command.x.mutating && !parsed.globals.commit && !io.stdinIsTTY) {
      throw new AgwError('confirmation_required', `${command.words.join(' ')} changes state; nothing was sent`, {
        hint: `re-run with --commit: ${usageLine(command)}`,
      })
    }
    const format = parsed.globals.format ?? (io.stdoutIsTTY ? command.x.defaultFormat : 'json')
    const emit = (body: unknown) => io.out(`${render(body, format, command)}\n`)
    const plan = waitPlan(this.host.commands, command)
    const budgetS = waitBudgetS(io.env)
    const deadline = Date.now() + budgetS * 1000

    let reply: Reply
    try {
      reply = await this.host.call(command, values, {
        idempotencyKey: parsed.globals.idempotencyKey,
        ...(plan ? { waitS: Math.floor(budgetS) } : {}),
      })
    } catch (error) {
      if (error instanceof AgwError && error.kind === 'contract_mismatch') throw new StaleContract(error)
      throw error
    }
    if (!plan) {
      emit(reply.body)
      return EXIT.ok
    }

    let state = (reply.body ?? {}) as RunState
    const resume = plan.resume
    const resumeCommand = resume && this.host.commands.find((c) => c.words.join(' ') === resume.command.join(' '))
    const resumeValues = Object.fromEntries((resume?.positional ?? []).map((name) => [name, state[name]]))
    const resumeLine = resume
      ? [BIN, ...resume.command, ...Object.values(resumeValues).map((v) => shellWord(String(v)))].join(' ')
      : ''

    while (reply.status === 202 && resumeCommand) {
      const leftS = Math.floor((deadline - Date.now()) / 1000)
      if (leftS < 1) break
      const started = Date.now()
      try {
        reply = await this.host.call(resumeCommand, resumeValues, { waitS: Math.min(leftS, MAX_WAIT_S) })
      } catch (error) {
        throw await this.resumable(error, resumeLine)
      }
      state = (reply.body ?? {}) as RunState
      // A host that answers 202 at once must not be hammered.
      if (reply.status === 202) await Bun.sleep(Math.max(0, 1000 - (Date.now() - started)))
    }

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

  /** A failure mid-wait: the run keeps going server-side, so the hint is the resume command. */
  private async resumable(error: unknown, resumeLine: string): Promise<unknown> {
    if (!(error instanceof AgwError) || !resumeLine) return error
    if (error.kind === 'contract_mismatch') await this.host.refresh().catch(() => undefined)
    if (error.kind !== 'network' && error.kind !== 'contract_mismatch') return error
    return new AgwError(error.kind, error.message, { code: error.code, hint: resumeLine, details: error.details })
  }

  private async topHelp(): Promise<number> {
    if (!this.host.loadCache()) await this.host.refresh().catch(() => undefined)
    const lines = [
      `${BIN} <command> [args] [--help]    ${BIN} schema [command…] [--refresh] [--exit-codes]`,
      '',
      ...this.host.commands.map((c) => `  ${usageLine(c)}`),
    ]
    if (!this.host.commands.length) lines.push(`  (no cached contract; ${BIN} schema --refresh fetches it)`)
    this.io.out(`${lines.join('\n')}\n`)
    return EXIT.ok
  }

  private async schema(tokens: string[]): Promise<number> {
    const words: string[] = []
    let refresh = false
    let exitCodes = false
    let format: 'json' | 'plain' = 'json'
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i] as string
      if (token === '--refresh') refresh = true
      else if (token === '--exit-codes') exitCodes = true
      else if (token === '--format' || token.startsWith('--format=')) {
        const value = token.includes('=') ? token.slice(9) : tokens[++i]
        if (value !== 'json' && value !== 'plain') throw usage(`--format must be json or plain, got: ${value}`)
        format = value
      } else if (token.startsWith('-'))
        throw usage(`unknown flag ${token}`, 'valid flags: --refresh --exit-codes --format')
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
    if (refresh) await this.host.refresh()
    else await this.host.load()

    const { commands, sha } = this.host
    if (!words.length) {
      print({
        contractSha: sha,
        commands: commands.map((c) => ({
          command: c.words.join(' '),
          kind: c.x.kind,
          mutating: c.x.mutating,
          summary: c.summary,
          usage: usageLine(c),
        })),
      })
      return EXIT.ok
    }
    const exact = commands.find((c) => c.words.join(' ') === words.join(' '))
    if (exact) {
      print(this.describe(exact))
      return EXIT.ok
    }
    const below = commands.filter((c) => words.every((w, i) => c.words[i] === w))
    if (!below.length) {
      const { prefix, options } = nextWords(commands, words)
      throw usage(
        `unknown command '${words.join(' ')}'`,
        options.length ? `${[BIN, 'schema', ...prefix].join(' ')} ${options.join('|')}` : `${BIN} schema`,
      )
    }
    print(below.map((c) => this.describe(c)))
    return EXIT.ok
  }

  private describe(command: Command) {
    const properties: Record<string, Schema> = {}
    for (const f of command.fields) {
      const at = command.x.positional.indexOf(f.name)
      properties[f.name] = { ...f.schema, ...(at >= 0 ? { 'x-positional': at } : { 'x-flag': `--${f.flag}` }) }
    }
    return {
      command: command.words.join(' '),
      kind: command.x.kind,
      summary: command.summary,
      usage: usageLine(command),
      contractSha: this.host.sha,
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
