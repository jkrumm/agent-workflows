import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { cleanup, type Exec, exec as bunExec, type GtCase, materialize } from '@agent-workflows/eval'

const GIT_TIMEOUT_MS = 120_000

/** The isolated clone a case is reviewed in, and the commit's diff for the judge. */
export interface RecallClones {
  /** A clone at the case's sha with no refs, origin or alternates, its parent reachable. */
  create(reference: GtCase): Promise<{ ok: true; dir: string } | { ok: false; reason: string }>
  remove(dir: string): void
  /** `git show --format= <sha>` in the clone. */
  diff(dir: string, sha: string): Promise<string>
}

/**
 * Where the clones go: inside the factory's `FACTORY_REPO_ROOTS` (default `$HOME/SourceRoot`), which refuses a repo
 * outside them, and under a dot name, which the miner skips. `AGW_EVAL_CLONES_DIR` overrides it.
 */
export function clonesRoot(env: Record<string, string | undefined>): string {
  return (
    env.AGW_EVAL_CLONES_DIR?.trim() || join(env.AGW_EVAL_HOME?.trim() || homedir(), 'SourceRoot', '.agw-eval-recall')
  )
}

export function gitClones(options: { env: Record<string, string | undefined>; exec?: Exec }): RecallClones {
  const exec = options.exec ?? bunExec
  const home = options.env.AGW_EVAL_HOME?.trim() || homedir()
  const git = (dir: string, args: string[]) =>
    exec('git', args, { cwd: dir, timeoutMs: GIT_TIMEOUT_MS, env: { GIT_TERMINAL_PROMPT: '0' } })
  return {
    async create(reference) {
      const tmpRoot = clonesRoot(options.env)
      mkdirSync(tmpRoot, { recursive: true, mode: 0o700 })
      const made = await materialize(
        { repo: reference.repo, baseSha: reference.sha, isolate: true },
        { exec, home, tmpRoot, setup: false },
      )
      if (!made.ok) {
        if (made.dir) cleanup(made.dir)
        return { ok: false, reason: `${made.reason}: ${made.detail}` }
      }
      const parent = await git(made.dir, ['cat-file', '-e', `${reference.parent}^{commit}`])
      if (parent.code !== 0) {
        cleanup(made.dir)
        return { ok: false, reason: `the parent ${reference.parent} is not reachable from ${reference.sha}` }
      }
      return { ok: true, dir: made.dir }
    },
    remove: cleanup,
    async diff(dir, sha) {
      const shown = await git(dir, ['show', '--format=', sha])
      if (shown.code !== 0) throw new Error(`git show ${sha}: ${shown.stderr.trim()}`)
      return shown.stdout
    },
  }
}
