import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Exec } from './exec.ts'

export type ProbeLogger = { warn(message: string, meta?: Record<string, unknown>): void }

/**
 * `make -p -q` only dumps the database; a `$(shell …)` or `include` can still block, so the probe is bounded. Loose
 * on purpose: an overrun silently sends the run to the paid agent path, and a loaded host takes seconds to start make.
 */
const PROBE_WALL_MS = 30_000

/**
 * Whether a `make -p` database dump registers `check` as a rule. Each entry Make knows is listed under `# Files`
 * as a header line (`check:`, `check::`, `check: lint test`); one Make only knows as a prerequisite or an existing
 * file is preceded by `# Not a target:`. A bare `check:` counts only with a recipe, since `make check` on an empty
 * rule exits 0 having validated nothing. A `check-foo` target, a catch-all `%:` rule (under `# Implicit Rules`) and a
 * `define … endef` body (under `# Variables`) are not matches.
 */
export function makeDatabaseHasCheckTarget(db: string): boolean {
  const lines = db.split('\n')
  const files = lines.indexOf('# Files')
  if (files < 0) return false
  for (let i = files + 1; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (line.startsWith('# files hash-table stats') || line.startsWith('# VPATH Search Paths')) break
    const header = /^check::?(.*)$/.exec(line)
    if (!header || lines[i - 1] === '# Not a target:') continue
    if ((header[1] ?? '').trim() !== '') return true
    // The recipe marker sits in the header's own block: comments and tab-indented lines up to the next entry.
    for (let j = i + 1; j < lines.length && !/^[^ \t#]/.test(lines[j] ?? ''); j++) {
      if (/(commands|recipe) to execute \(from/.test(lines[j] ?? '')) return true
    }
  }
  return false
}

/**
 * Whether the Makefile in `cwd` has a real `check:` target. A missing Makefile or `make` is "no": the agent path runs
 * instead, never a red. So is a probe that overruns or comes back cut, but that one is logged: it costs tokens.
 * Throws when `signal` aborts.
 */
export async function hasMakeCheckTarget(
  exec: Exec,
  cwd: string,
  options: { signal?: AbortSignal; logger?: ProbeLogger } = {},
): Promise<boolean> {
  // GNU make's own lookup order
  if (!['GNUmakefile', 'makefile', 'Makefile'].some((name) => existsSync(join(cwd, name)))) return false
  if (!exec.which('make')) return false
  // `-q` is load-bearing: bare `make -p` builds the default goal after the dump and would run a recipe.
  const probe = await exec.run({
    argv: ['make', '-p', '-q'],
    cwd,
    wallMs: PROBE_WALL_MS,
    tailChars: Number.POSITIVE_INFINITY, // the `# Files` section is at the end of the dump; keep all of it
    stderr: 'discard',
    signal: options.signal,
  })
  if (probe.aborted) throw options.signal?.reason ?? new Error('make check probe aborted')
  if (probe.timedOut || probe.truncated) {
    options.logger?.warn('make check probe did not complete; falling back to the agent path', {
      cwd,
      timedOut: probe.timedOut,
      truncated: probe.truncated,
    })
    return false
  }
  return makeDatabaseHasCheckTarget(probe.output)
}
