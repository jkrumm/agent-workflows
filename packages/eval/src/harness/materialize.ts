import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brief, type Exec } from './exec.ts'

const GIT_TIMEOUT_MS = 120_000
const SETUP_TIMEOUT_MS = 600_000

export type SkipReason = 'repo_missing' | 'checkout_failed' | 'apply_failed' | 'setup_failed'

export type Materialized =
  | { ok: true; dir: string; setup: string[] }
  | { ok: false; reason: SkipReason; detail: string; dir?: string }

export interface MaterializeInput {
  repo: string
  baseSha: string
  /** The review case's `diff` or the check case's `patch`; applied as uncommitted changes. */
  patch?: string
}

export interface MaterializeOptions {
  exec: Exec
  /** The root `case.repo` is relative to (`$HOME`). */
  home: string
  /** Where the throwaway clone goes (default: the OS temp dir). */
  tmpRoot?: string
  /** Run the repo's setup (`bun install --frozen-lockfile`) when its check needs it; off for review and dry runs. */
  setup: boolean
}

/**
 * A throwaway clone at `baseSha` with the case's diff as uncommitted changes. `--shared` borrows the owner's
 * object store read-only: nothing is written to the owner's checkout.
 */
export async function materialize(input: MaterializeInput, options: MaterializeOptions): Promise<Materialized> {
  const { exec } = options
  const source = join(options.home, input.repo)
  if (!existsSync(join(source, '.git'))) {
    return { ok: false, reason: 'repo_missing', detail: `${input.repo} is not a git checkout under the home root` }
  }
  const dir = join(mkdtempSync(join(options.tmpRoot ?? tmpdir(), 'agw-eval-')), 'repo')
  const git = (args: string[], stdin?: string) =>
    exec('git', args, { cwd: dir, stdin, timeoutMs: GIT_TIMEOUT_MS, env: { GIT_TERMINAL_PROMPT: '0' } })

  const clone = await exec('git', ['clone', '--quiet', '--shared', '--no-checkout', source, dir], {
    timeoutMs: GIT_TIMEOUT_MS,
  })
  if (clone.code !== 0) return { ok: false, reason: 'checkout_failed', detail: brief(clone.stderr), dir }
  const checkout = await git(['checkout', '--quiet', '--detach', input.baseSha])
  if (checkout.code !== 0) return { ok: false, reason: 'checkout_failed', detail: brief(checkout.stderr), dir }

  if (input.patch?.trim()) {
    const patch = input.patch.endsWith('\n') ? input.patch : `${input.patch}\n`
    // Intent-to-add: files the patch creates show in `git diff HEAD`, which a scope of uncommitted changes may read.
    const applied = await git(['apply', '--intent-to-add', '--whitespace=nowarn', '-'], patch)
    if (applied.code !== 0) return { ok: false, reason: 'apply_failed', detail: brief(applied.stderr), dir }
  }

  const setup = options.setup ? setupSteps(dir) : []
  for (const step of setup) {
    const [cmd, ...args] = step.split(' ') as [string, ...string[]]
    const ran = await exec(cmd, args, { cwd: dir, timeoutMs: SETUP_TIMEOUT_MS })
    if (ran.code !== 0) return { ok: false, reason: 'setup_failed', detail: `${step}: ${brief(ran.stderr)}`, dir }
  }
  return { ok: true, dir, setup }
}

/** Setup the check needs before it runs: a bun lockfile and a Makefile `check` that does not install itself. */
export function setupSteps(dir: string): string[] {
  const lockfile = existsSync(join(dir, 'bun.lock')) || existsSync(join(dir, 'bun.lockb'))
  if (!lockfile) return []
  const makefile = join(dir, 'Makefile')
  const recipe = existsSync(makefile) ? checkRecipe(readFileSync(makefile, 'utf8')) : ''
  return recipe.includes('bun install') ? [] : ['bun install --frozen-lockfile']
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
