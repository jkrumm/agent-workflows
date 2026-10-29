import { BIN } from './args.ts'
import { type Credentials, credentials, type Env } from './config.ts'
import { AgwError } from './exit.ts'
import { type CallOptions, Host, type Reply, Unreachable } from './host.ts'
import { type Command, canonical } from './spec.ts'

/** One process's declaration of a command. */
export interface Declaration {
  host: Host
  command: Command
}

/** The merged view, built once per set of loaded contracts. */
interface Index {
  sources: Command[][]
  declarations: Declaration[]
  byKey: Map<string, Declaration[]>
  commands: Command[]
  conflicts: Map<string, string[]>
}

const keyOf = (command: Command) => command.words.join(' ')

/** What makes two declarations the same operation: the wire shape, every input schema, the output and `x-cli`. */
const operationShape = (c: Command) =>
  JSON.stringify(
    canonical([
      c.method,
      c.path,
      c.x,
      c.hasBody,
      c.output ?? null,
      c.fields.map((f) => [f.name, f.in, f.required, f.schema]),
    ]),
  )

/**
 * Every process of the platform behind one merged command set: the host (`AGW_URL`) first, then `AGW_PROCESSES` in
 * declared order. Each command routes to the process whose contract declared it. A command two processes declare is a
 * conflict and never runs, except the run commands (`kind: 'run'`) every process serves identically from the shared
 * journal: those go to the first process that can be reached, the host first.
 */
export class Platform {
  readonly host: Host
  #creds: Credentials | undefined
  #processes: Host[] | undefined
  #index: Index | undefined
  /** Why a process's contract could not be fetched in this call, by process name. */
  readonly #failures = new Map<string, string>()
  /** The process a failed call went to, so a 412 refreshes that contract and no other. */
  readonly #sentTo = new WeakMap<object, Host>()

  constructor(readonly env: Env) {
    this.host = new Host(env, undefined, () => this.creds())
  }

  /** Read and validated once per call, and shared by every process. */
  private creds(): Credentials {
    this.#creds ??= credentials(this.env)
    return this.#creds
  }

  /** Read on first use, like the credentials: `agw schema --exit-codes` needs no configuration at all. */
  get processes(): Host[] {
    this.#processes ??= [
      this.host,
      ...this.creds().processes.map((target) => new Host(this.env, target, () => this.creds())),
    ]
    return this.#processes
  }

  /** Whether `AGW_PROCESSES` names any process: only then does output name processes. */
  get multi(): boolean {
    return this.processes.length > 1
  }

  get secondaries(): Host[] {
    return this.processes.slice(1)
  }

  failure(host: Host): string | undefined {
    return this.#failures.get(host.name)
  }

  /**
   * The refresh failures that could explain an unknown command: the host's always (as it always was), another
   * process's only when it could declare these words (no contract known, or a command under the same first word).
   */
  failuresFor(argv: string[]): string | undefined {
    const first = argv.find((w) => !w.startsWith('-'))
    const lines = this.processes.flatMap((p) => {
      const why = this.#failures.get(p.name)
      if (why === undefined) return []
      const could = p === this.host || !p.commands.length || p.commands.some((c) => c.words[0] === first)
      return could ? [why] : []
    })
    return lines.length ? lines.join('; ') : undefined
  }

  get allRefreshed(): boolean {
    return this.processes.every((p) => p.refreshed)
  }

  /** Rebuilt only when a process loaded another contract. */
  private get index(): Index {
    const sources = this.processes.map((p) => p.commands)
    if (this.#index?.sources.every((s, i) => s === sources[i])) return this.#index
    const declarations = this.processes.flatMap((host) => host.commands.map((command) => ({ host, command })))
    const byKey = new Map<string, Declaration[]>()
    for (const d of declarations) byKey.set(keyOf(d.command), [...(byKey.get(keyOf(d.command)) ?? []), d])
    const conflicts = new Map<string, string[]>()
    for (const [key, owners] of byKey) {
      if (owners.length < 2) continue
      const [first, ...rest] = owners.map((d) => operationShape(d.command))
      const shared = owners.every((d) => d.command.x.kind === 'run') && rest.every((shape) => shape === first)
      if (!shared)
        conflicts.set(
          key,
          owners.map((d) => d.host.name),
        )
    }
    const commands = [...byKey.values()].map((owners) => (owners[0] as Declaration).command)
    this.#index = { sources, declarations, byKey, commands, conflicts }
    return this.#index
  }

  /** Every command of every process, in process order. */
  declarations(): Declaration[] {
    return this.index.declarations
  }

  /** One command per command line: the first process's declaration stands for the others. */
  get commands(): Command[] {
    return this.index.commands
  }

  /** The processes that declared these command words, in process order. */
  owners(command: Command): Declaration[] {
    return this.index.byKey.get(keyOf(command)) ?? []
  }

  /** The process names of a command more than one process declares in a way the CLI cannot share. */
  conflict(command: Command): string[] | undefined {
    return this.index.conflicts.get(keyOf(command))
  }

  conflictError(command: Command): AgwError | undefined {
    const names = this.conflict(command)
    if (!names) return undefined
    return new AgwError(
      'contract_mismatch',
      `'${keyOf(command)}' is declared by more than one process: ${names.join(', ')}`,
      { hint: `${BIN} schema lists every process with its operations`, details: { processes: names } },
    )
  }

  /**
   * The host as today (its cache, else a fetch that must succeed); the others from their caches. `fetchMissing` also
   * fetches the contract of every other process that has none, in parallel. A command call does not: an unknown
   * command fetches them on the stale path, so a hung process never delays a host command.
   */
  async load({ fetchMissing = false } = {}): Promise<void> {
    await this.host.load()
    const missing = this.secondaries.filter((p) => !p.loadCache())
    if (fetchMissing) await Promise.all(missing.map((p) => this.tryRefresh(p)))
  }

  /** Fetches each contract at most once per call, in parallel; a process that cannot answer keeps its cache. */
  async freshen(): Promise<void> {
    await Promise.all(this.processes.filter((p) => !p.refreshed).map((p) => this.tryRefresh(p)))
  }

  /** Every contract fetched at once and independently; then the host's failure is the answer, as it always was. */
  async refreshAll(): Promise<void> {
    const pending = this.processes.filter((p) => !p.refreshed)
    const errors = await Promise.all(pending.map((p) => this.tryRefresh(p)))
    const hostError = errors[pending.indexOf(this.host)]
    if (hostError !== undefined) throw hostError
  }

  /** Resolves to the error, recorded by process name; never rejects. */
  private async tryRefresh(p: Host): Promise<unknown> {
    try {
      await p.refresh()
      this.#failures.delete(p.name)
      return undefined
    } catch (error) {
      this.#failures.set(p.name, error instanceof Error ? error.message : String(error))
      return error
    }
  }

  /**
   * Sends the command to the process that declared it. A shared run command tries the next process only when the
   * connection to the last was never opened: the journal answers for every run, so any process gives the same answer,
   * and a request that may have landed is never sent twice.
   */
  async call(
    command: Command,
    values: Record<string, unknown>,
    options: CallOptions = {},
  ): Promise<{ reply: Reply; host: Host }> {
    const owners = this.owners(command)
    for (const [i, { host, command: own }] of owners.entries()) {
      try {
        return { reply: await host.call(own, values, options), host }
      } catch (error) {
        if (error instanceof Unreachable && i < owners.length - 1) continue
        if (error !== null && typeof error === 'object') this.#sentTo.set(error, host)
        throw error
      }
    }
    throw new AgwError('usage', `no process declares '${keyOf(command)}'`)
  }

  /** The process a failed {@link call} was sent to. */
  sentTo(error: unknown): Host | undefined {
    return error !== null && typeof error === 'object' ? this.#sentTo.get(error) : undefined
  }

  /**
   * After a 412 from `host`: its contract, fetched again. The host's failure is its own error, as it always was;
   * another process that cannot hand over a contract is unavailable.
   */
  async refreshProcess(host: Host): Promise<void> {
    if (host === this.host) return host.refresh()
    try {
      await host.refresh()
    } catch (error) {
      if (error instanceof AgwError && error.kind === 'network') throw error
      const why = error instanceof Error ? error.message : String(error)
      throw new AgwError('network', `process ${host.name} is unavailable: ${why}`, {
        hint: `is the process ${host.name} up? ${BIN} schema works offline from the cache`,
      })
    }
  }
}
