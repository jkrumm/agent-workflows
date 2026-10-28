import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Exec } from './exec.ts'

/** `make -p -q` only dumps the database; a `$(shell …)` or `include` can still block, so the probe is bounded. */
const PROBE_WALL_MS = 5_000
/** The database of a big Makefile is a few hundred KB; the `# Files` section is at its end. */
const PROBE_TAIL_CHARS = 4_000_000

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
 * Whether the Makefile in `cwd` has a real `check:` target. A missing Makefile or `make`, or a probe that overruns,
 * is "no": the agent path runs instead, never a red.
 */
export async function hasMakeCheckTarget(exec: Exec, cwd: string): Promise<boolean> {
  // GNU make's own lookup order
  if (!['GNUmakefile', 'makefile', 'Makefile'].some((name) => existsSync(join(cwd, name)))) return false
  if (!exec.which('make')) return false
  // `-q` is load-bearing: bare `make -p` builds the default goal after the dump and would run a recipe.
  const probe = await exec.run({
    argv: ['make', '-p', '-q'],
    cwd,
    wallMs: PROBE_WALL_MS,
    tailChars: PROBE_TAIL_CHARS,
    stderr: 'discard',
  })
  return !probe.timedOut && makeDatabaseHasCheckTarget(probe.output)
}
