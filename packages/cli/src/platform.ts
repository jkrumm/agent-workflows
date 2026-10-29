import { BIN } from './args.ts'
import { credentials, type Env } from './config.ts'
import { AgwError } from './exit.ts'
import { type CallOptions, Host, type Reply, Unreachable } from './host.ts'
import type { Command } from './spec.ts'

/** One process's declaration of a command. */
export interface Declaration {
  host: Host
  command: Command
}

/**
 * Every process of the platform behind one merged command set: the host (`AGW_URL`) first, then `AGW_PROCESSES` in
 * declared order. Each command routes to the process whose contract declared it. A command two processes declare is a
 * conflict and never runs, except the run commands (`kind: 'run'`) every process serves identically from the shared
 * journal: those go to the first process that can be reached, the host first.
 */
export class Platform {
  readonly host: Host
  #processes: Host[] | undefined
  /** Why a process's contract could not be fetched in this call, by process name. */
  readonly #failures = new Map<string, string>()

  constructor(readonly env: Env) {
    this.host = new Host(env)
  }

  /** Read on first use, like the credentials: `agw schema --exit-codes` needs no configuration at all. */
  get processes(): Host[] {
    this.#processes ??= [this.host, ...credentials(this.env).processes.map((t) => new Host(this.env, t))]
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

  /** Every refresh failure of this call; another process's message names it (`process <name> …`). */
  failures(): string | undefined {
    const lines = this.processes.flatMap((p) => this.#failures.get(p.name) ?? [])
    return lines.length ? lines.join('; ') : undefined
  }

  get allRefreshed(): boolean {
    return this.processes.every((p) => p.refreshed)
  }

  /** Every command of every process, in process order. */
  declarations(): Declaration[] {
    return this.processes.flatMap((host) => host.commands.map((command) => ({ host, command })))
  }

  /** One command per command line: the first process's declaration stands for the others. */
  get commands(): Command[] {
    const seen = new Set<string>()
    return this.declarations().flatMap(({ command }) => {
      const key = command.words.join(' ')
      if (seen.has(key)) return []
      seen.add(key)
      return [command]
    })
  }

  /** The processes that declared these command words, in process order. */
  owners(command: Command): Declaration[] {
    const key = command.words.join(' ')
    return this.declarations().filter((d) => d.command.words.join(' ') === key)
  }

  /** The process names of a command more than one process declares in a way the CLI cannot share. */
  conflict(command: Command): string[] | undefined {
    const owners = this.owners(command)
    if (owners.length < 2) return undefined
    const [first] = owners.map((d) => operationShape(d.command))
    if (owners.every((d) => d.command.x.kind === 'run' && operationShape(d.command) === first)) return undefined
    return owners.map((d) => d.host.name)
  }

  assertNoConflict(command: Command): void {
    const names = this.conflict(command)
    if (!names) return
    throw new AgwError(
      'contract_mismatch',
      `'${command.words.join(' ')}' is declared by more than one process: ${names.join(', ')}`,
      { hint: `${BIN} schema lists every process with its operations`, details: { processes: names } },
    )
  }

  /** The host as today (its cache, else a fetch that must succeed); another process only when it can answer. */
  async load(): Promise<void> {
    await this.host.load()
    for (const p of this.secondaries) if (!p.loadCache()) await this.tryRefresh(p)
  }

  /** Fetches each process's contract at most once per call; a process that cannot answer keeps its cache. */
  async freshen(): Promise<void> {
    for (const p of this.processes) if (!p.refreshed) await this.tryRefresh(p)
  }

  /** The host's fetch must succeed (its error is the answer, as it always was); the others are best effort. */
  async refreshAll(): Promise<void> {
    if (!this.host.refreshed) await this.host.refresh()
    for (const p of this.secondaries) if (!p.refreshed) await this.tryRefresh(p)
  }

  private async tryRefresh(p: Host): Promise<void> {
    try {
      await p.refresh()
      this.#failures.delete(p.name)
    } catch (error) {
      this.#failures.set(p.name, error instanceof Error ? error.message : String(error))
    }
  }

  /**
   * Sends the command to the process that declared it. A shared run command tries the next process only when the
   * last could not be reached at all: the journal answers for every run, so any process gives the same answer.
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
        if (!(error instanceof Unreachable) || i === owners.length - 1) throw error
      }
    }
    throw new AgwError('usage', `no process declares '${command.words.join(' ')}'`)
  }

  /**
   * After a 412: the contracts of the processes that declare the command, fetched again. The host's failure is its
   * own error, as it always was; another process that cannot hand over a contract is unavailable.
   */
  async refreshOwners(command: Command): Promise<void> {
    for (const { host } of this.owners(command)) {
      if (host === this.host) {
        await host.refresh()
        continue
      }
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
}

/** What makes two declarations the same operation: the wire shape and the `x-cli` block. */
function operationShape(c: Command): string {
  const fields = c.fields.map((f) => [f.name, f.in, f.required])
  return JSON.stringify([c.method, c.path, c.x, fields])
}
