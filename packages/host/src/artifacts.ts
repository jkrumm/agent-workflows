import { existsSync, mkdirSync, readdirSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_STATE_DIR } from '@agent-workflows/opencode-host'

/**
 * The platform's artifact store: files a run produces for its caller (images, audio). The host writes no caller path: a
 * workflow asks for `artifactDir(workflow, runId)` and reports the absolute paths it wrote in its output.
 *
 * Layout: `<root>/<workflow>/<runId>/<file>`, root `$AGW_ARTIFACTS_DIR` or `artifacts/` under the host's state directory
 * (`~/.local/state/agent-workflows`: durable, outside any release, next to the tool gate's `gate.json`).
 *
 * **Retention: 30 days.** A run's directory is removed once nothing in it changed for `RETENTION_DAYS`. The sweep runs on
 * write (the first `artifactDir` of a process, then at most hourly), so the store needs no schedule of its own; `sweep`
 * is exported for a caller that wants one. A file a caller wants to keep is copied out of the store.
 *
 * **The sweep deletes, so it is narrow.** It runs only in a root that carries the `.agw-artifacts` marker (written when
 * `artifactDir` creates the store), and only removes `<workflow>/<runId>` directories whose names match the patterns
 * `artifactDir` accepts. A root redirected at a shared directory is left alone.
 */
export const RETENTION_DAYS = 30
export const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000
const SWEEP_EVERY_MS = 60 * 60 * 1000
export const MARKER = '.agw-artifacts'

type Env = Record<string, string | undefined>

export function artifactRoot(env: Env = process.env): string {
  return env.AGW_ARTIFACTS_DIR?.trim() || join(DEFAULT_STATE_DIR, 'artifacts')
}

const WORKFLOW = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/
const RUN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

export interface ArtifactOptions {
  env?: Env
  /** Replaces the root (tests). */
  root?: string
  /** The clock (tests). Default `Date.now()`. */
  now?: number
}

const lastSweep = new Map<string, number>()

/** The run's directory, created (mode 0700: artifacts are the owner's). Names that could leave the store are refused. */
export function artifactDir(workflow: string, runId: string, options: ArtifactOptions = {}): string {
  if (!WORKFLOW.test(workflow)) throw new Error(`artifactDir: invalid workflow id "${workflow}"`)
  if (!RUN.test(runId)) throw new Error(`artifactDir: invalid run id "${runId}"`)
  const root = options.root ?? artifactRoot(options.env)
  const now = options.now ?? Date.now()
  const dir = join(root, workflow, runId)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const marker = join(root, MARKER)
  if (!existsSync(marker))
    writeFileSync(marker, 'agent-workflows artifact store; directories under it are swept after 30 days\n', {
      mode: 0o600,
    })
  if (now - (lastSweep.get(root) ?? -Infinity) >= SWEEP_EVERY_MS) {
    lastSweep.set(root, now)
    sweep(RETENTION_MS, { root, now })
  }
  return dir
}

export interface SweepResult {
  /** The run directories removed. */
  removed: string[]
}

/**
 * Removes every run directory whose own modification time is older than `olderThanMs` (adding a file touches it).
 * Best effort: an entry that cannot be read or removed is left for the next sweep. Workflow directories left empty are removed.
 */
export function sweep(olderThanMs: number, options: ArtifactOptions = {}): SweepResult {
  const root = options.root ?? artifactRoot(options.env)
  if (!existsSync(join(root, MARKER))) return { removed: [] }
  const cutoff = (options.now ?? Date.now()) - olderThanMs
  const removed: string[] = []
  for (const workflow of listDirs(root).filter((name) => WORKFLOW.test(name))) {
    const workflowDir = join(root, workflow)
    for (const run of listDirs(workflowDir).filter((name) => RUN.test(name))) {
      const dir = join(workflowDir, run)
      try {
        if (statSync(dir).mtimeMs >= cutoff) continue
        rmSync(dir, { recursive: true, force: true })
        removed.push(dir)
      } catch {}
    }
    try {
      rmdirSync(workflowDir) // only succeeds when empty
    } catch {}
  }
  return { removed }
}

function listDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return []
  }
}
