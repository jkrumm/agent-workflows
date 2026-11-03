import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brief, type Exec, type ExecResult } from './exec.ts'

const GIT_TIMEOUT_MS = 120_000
const SETUP_TIMEOUT_MS = 600_000

export type SkipReason = 'repo_missing' | 'checkout_failed' | 'apply_failed' | 'setup_failed' | 'isolate_failed'

export type Materialized = { ok: true; dir: string } | { ok: false; reason: SkipReason; detail: string; dir?: string }

export interface MaterializeInput {
  repo: string
  baseSha: string
  /** The check case's `patch`; applied as uncommitted changes. */
  patch?: string
  /**
   * Leave nothing in the clone but the history up to `baseSha`: every ref is deleted, the reflog expired and the
   * reachable objects copied in before the `--shared` alternates are cut, so neither `git log --all` nor
   * `git show <sha>` reaches a later commit (a fix the reviewed commit's bug has must not be findable from a shell).
   */
  isolate?: boolean
}

export interface MaterializeOptions {
  exec: Exec
  /** The root `case.repo` is relative to (`$HOME`). */
  home: string
  /** Where the throwaway clone goes (default: the OS temp dir). */
  tmpRoot?: string
  /** Run the repo's setup (`bun install --frozen-lockfile`) when its check needs it; off for dry runs. */
  setup: boolean
}

/**
 * A throwaway clone at `baseSha` with the case's diff as uncommitted changes. `--shared` borrows the owner's
 * object store read-only: nothing is written to the owner's checkout. The `agw_eval_` prefix has no dash: a random
 * suffix starting with `O` after `agw-eval-` would make `-O`, which a shell refuses in a path.
 */
export async function materialize(input: MaterializeInput, options: MaterializeOptions): Promise<Materialized> {
  const { exec } = options
  const source = join(options.home, input.repo)
  if (!existsSync(join(source, '.git'))) {
    return { ok: false, reason: 'repo_missing', detail: `${input.repo} is not a git checkout under the home root` }
  }
  const dir = join(mkdtempSync(join(options.tmpRoot ?? tmpdir(), 'agw_eval_')), 'repo')
  const git = (args: string[], stdin?: string) =>
    exec('git', args, { cwd: dir, stdin, timeoutMs: GIT_TIMEOUT_MS, env: { GIT_TERMINAL_PROMPT: '0' } })

  const clone = await exec('git', ['clone', '--quiet', '--shared', '--no-checkout', source, dir], {
    timeoutMs: GIT_TIMEOUT_MS,
  })
  if (clone.code !== 0) return { ok: false, reason: 'checkout_failed', detail: brief(clone.stderr), dir }
  const checkout = await git(['checkout', '--quiet', '--detach', input.baseSha])
  if (checkout.code !== 0) return { ok: false, reason: 'checkout_failed', detail: brief(checkout.stderr), dir }

  if (input.isolate) {
    const isolated = await isolateHistory(git, dir)
    if (isolated) return { ok: false, reason: 'isolate_failed', detail: isolated, dir }
  }

  if (input.patch?.trim()) {
    const patch = input.patch.endsWith('\n') ? input.patch : `${input.patch}\n`
    // Intent-to-add: files the patch creates show in `git diff HEAD`, which a scope of uncommitted changes may read.
    const applied = await git(['apply', '--intent-to-add', '--whitespace=nowarn', '-'], patch)
    if (applied.code !== 0) return { ok: false, reason: 'apply_failed', detail: brief(applied.stderr), dir }
  }

  for (const step of options.setup ? setupSteps(dir) : []) {
    const ran = await exec(step.cmd, step.args, { cwd: dir, timeoutMs: SETUP_TIMEOUT_MS })
    if (ran.code !== 0) {
      return { ok: false, reason: 'setup_failed', detail: `${commandLine(step)}: ${brief(ran.stderr)}`, dir }
    }
  }
  return { ok: true, dir }
}

/**
 * Drops the remote and every ref (branches, tags, stash, packed), expires the reflogs, copies the objects reachable
 * from HEAD out of the shared store (`repack -a`, no `-l`), cuts the alternates and prunes. Returns a failure's detail.
 */
async function isolateHistory(
  git: (args: string[], stdin?: string) => Promise<ExecResult>,
  dir: string,
): Promise<string | null> {
  const remote = await git(['remote', 'remove', 'origin'])
  if (remote.code !== 0) return brief(remote.stderr)
  const refs = await git(['for-each-ref', '--format=%(refname)'])
  if (refs.code !== 0) return brief(refs.stderr)
  const names = refs.stdout.split('\n').filter(Boolean)
  if (names.length) {
    const deleted = await git(['update-ref', '--stdin'], `${names.map((n) => `delete ${n}`).join('\n')}\n`)
    if (deleted.code !== 0) return brief(deleted.stderr)
  }
  const expired = await git(['reflog', 'expire', '--expire=now', '--all'])
  if (expired.code !== 0) return brief(expired.stderr)
  const repacked = await git(['repack', '-a', '-d', '--quiet'])
  if (repacked.code !== 0) return brief(repacked.stderr)
  rmSync(join(dir, '.git', 'objects', 'info', 'alternates'), { force: true })
  const pruned = await git(['prune', '--expire=now'])
  return pruned.code === 0 ? null : brief(pruned.stderr)
}

export interface SetupStep {
  cmd: string
  args: string[]
}

export const commandLine = (step: SetupStep) => [step.cmd, ...step.args].join(' ')

/** Setup the check needs before it runs: a bun lockfile and a Makefile `check` that does not install itself. */
export function setupSteps(dir: string): SetupStep[] {
  const lockfile = existsSync(join(dir, 'bun.lock')) || existsSync(join(dir, 'bun.lockb'))
  if (!lockfile) return []
  const makefile = join(dir, 'Makefile')
  const recipe = existsSync(makefile) ? checkRecipe(readFileSync(makefile, 'utf8')) : ''
  return recipe.includes('bun install') ? [] : [{ cmd: 'bun', args: ['install', '--frozen-lockfile'] }]
}

function checkRecipe(makefile: string): string {
  const lines = makefile.split('\n')
  const start = lines.findIndex((l) => /^check\s*:/.test(l))
  if (start < 0) return ''
  const body: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith('\t') && line.trim() !== '') break
    body.push(line)
  }
  return body.join('\n')
}

/** Removes the clone and its temp parent. */
export function cleanup(dir: string): void {
  rmSync(join(dir, '..'), { recursive: true, force: true })
}
