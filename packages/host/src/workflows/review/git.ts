import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'
import type { Exec } from './exec.ts'
import { tail } from './exec.ts'
import { branchProblem, isPathScope, splitRange } from './schema.ts'

export type Env = Record<string, string | undefined>

/** What the review needs from the machine; every part defaults inside `createReviewWorkflows` and tests replace it. */
export type ReviewPorts = {
  exec: Exec
  /** Path of a binary on PATH, or null. */
  which: (bin: string) => string | null
  env: Env
  /** The host state directory; throwaway clones live under `<stateDir>/review-clones/`. */
  stateDir: string
  now: () => number
}

/** A base ref the static tools take: an explicit one, fallow's own merge-base detection, or none for this scope. */
export type Base = { kind: 'base'; ref: string } | { kind: 'auto' } | { kind: 'skip' }

/** How `ocr review` is pointed at the change: the working tree, the last commit, or a from..to range. */
export type OcrMode = { mode: 'uncommitted' | 'head' | 'range'; from: string | null; to: string | null }

export type Prepared = {
  ok: true
  /** The directory the agents and tools read: `cwd`, or the throwaway clone of a `pr`/`branch` review. */
  repo: string
  /** The clone to remove when the run ends; null when `repo` is the caller's own checkout. */
  clone: string | null
  label: string
  diff: string
  files: string[]
  changedLines: number
  hasTestScript: boolean
  /** fallow's brief, a `fallow failed …` line, or '' when it is absent or not applicable. */
  fallow: string
  base: Base
  ocr: OcrMode | null
  gating: boolean
  adversary: boolean
  ocrEnabled: boolean
  ocrMinLines: number
  /** Why OCR cannot run on this machine (no `ocr`, no IU credentials), or null. */
  ocrBlocker: string | null
}

export type PrepareResult = Prepared | { ok: false; kind: 'invalid_input' | 'error'; message: string }

const GIT_TIMEOUT_MS = 30_000
const DIFF_TIMEOUT_MS = 60_000
const FETCH_TIMEOUT_MS = 120_000
const FALLOW_TIMEOUT_MS = 60_000
export const CLONE_ROOT = 'review-clones'
/** A clone older than this is a crashed run's: the next prepare removes it. */
const STALE_CLONE_MS = 24 * 3_600_000
const UNTRACKED_PARALLEL = 8

const invalid = (message: string): PrepareResult => ({ ok: false, kind: 'invalid_input', message })
const failure = (message: string): PrepareResult => ({ ok: false, kind: 'error', message })

/** Added plus removed lines in a unified diff, without the `+++`/`---` file headers. */
export function countChangedLines(diff: string): number {
  let n = 0
  for (const line of diff.split('\n')) {
    if ((line.startsWith('+') || line.startsWith('-')) && !/^(\+\+\+|---)( |$)/.test(line)) n++
  }
  return n
}

/** `fallow review --base <ref>` always reviews `<ref>...HEAD`: a range ending elsewhere has no equivalent, so it skips. */
export function baseFor(scope: string): Base {
  if (scope === 'uncommitted') return { kind: 'base', ref: 'HEAD' }
  if (scope === 'head') return { kind: 'base', ref: 'HEAD~1' }
  const range = splitRange(scope)
  if (range) {
    if (!range.from) return { kind: 'skip' }
    if (range.to && range.to !== 'HEAD') return { kind: 'skip' }
    return { kind: 'base', ref: range.from }
  }
  if (isPathScope(scope)) return { kind: 'auto' }
  return { kind: 'base', ref: scope }
}

/** `ocr review`'s mode for a scope; null when it has none (a file path, an open-ended range). */
export function ocrModeFor(scope: string, baseOid: string | null): OcrMode | null {
  if (baseOid) return { mode: 'range', from: baseOid, to: 'HEAD' }
  if (scope === 'uncommitted') return { mode: 'uncommitted', from: null, to: null }
  if (scope === 'head') return { mode: 'head', from: null, to: null }
  const range = splitRange(scope)
  if (range) return range.from ? { mode: 'range', from: range.from, to: range.to || 'HEAD' } : null
  if (isPathScope(scope)) return null
  return { mode: 'range', from: scope, to: 'HEAD' }
}

type GitRun = { ok: boolean; stdout: string; stderr: string }

function git(
  ports: ReviewPorts,
  cwd: string,
  args: readonly string[],
  timeoutMs = GIT_TIMEOUT_MS,
  env?: Record<string, string>,
) {
  return ports
    .exec(['git', ...args], { cwd, timeoutMs, env })
    .then((r): GitRun => ({ ok: r.code === 0, stdout: r.stdout, stderr: r.stderr }))
}

const names = (stdout: string) => stdout.split('\0').filter(Boolean)

/** Run `fn` over `items`, at most `limit` at a time, keeping order. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = next++
        if (i >= items.length) return
        out[i] = await fn(items[i] as T)
      }
    }),
  )
  return out
}

/** Untracked, non-ignored files as added-file hunks, without touching the caller's index (`git add -N` would). */
async function untrackedDiff(ports: ReviewPorts, repo: string): Promise<{ diff: string; files: string[] }> {
  const listed = await git(ports, repo, ['ls-files', '--others', '--exclude-standard', '-z'])
  const files = names(listed.stdout)
  const hunks = await mapLimit(files, UNTRACKED_PARALLEL, async (file) => {
    // `--no-index` exits 1 when it finds a difference: only the output matters.
    const r = await ports.exec(['git', 'diff', '--no-index', '--no-ext-diff', '--no-color', '--', '/dev/null', file], {
      cwd: repo,
      timeoutMs: GIT_TIMEOUT_MS,
    })
    return r.stdout
  })
  return { diff: hunks.join(''), files }
}

type Changes = { diff: string; files: string[] } | { error: string; kind: 'invalid_input' | 'error' }

/**
 * The change under review. `uncommitted` is staged and unstaged together (`git diff HEAD`) plus untracked files;
 * `head` is the last commit; a bare ref is `<ref>..HEAD`; an explicit range or a file path pass through. A `pr`/`branch`
 * review compares the fetched head to the default branch's tip (`<base>...HEAD`, no rename collapsing).
 */
async function changesFor(ports: ReviewPorts, repo: string, scope: string, baseOid: string | null): Promise<Changes> {
  const fail = (what: string, r: GitRun): Changes => {
    const text = (r.stderr || r.stdout).trim()
    const bad = /unknown revision|bad revision|ambiguous argument|not a valid|bad object/i.test(text)
    return {
      error: `git ${what} failed for scope "${scope}": ${text || 'no output'}`,
      kind: bad ? 'invalid_input' : 'error',
    }
  }
  const plain = ['--no-ext-diff', '--no-color']
  let diffArgs: string[]
  let nameArgs: string[]
  if (baseOid) {
    diffArgs = ['diff', ...plain, '--no-renames', `${baseOid}...HEAD`]
    nameArgs = ['diff', '--no-renames', '--name-only', '-z', `${baseOid}...HEAD`]
  } else if (scope === 'uncommitted') {
    const hasHead = (await git(ports, repo, ['rev-parse', '--verify', '--quiet', 'HEAD'])).ok
    const against = hasHead ? ['HEAD'] : ['--cached']
    diffArgs = ['diff', ...plain, ...against]
    nameArgs = ['diff', '--name-only', '-z', ...against]
  } else if (scope === 'head') {
    diffArgs = ['show', ...plain, 'HEAD']
    nameArgs = ['show', 'HEAD', '--name-only', '-z', '--format=']
  } else if (splitRange(scope)) {
    diffArgs = ['diff', ...plain, scope]
    nameArgs = ['diff', '--name-only', '-z', scope]
  } else if (isPathScope(scope)) {
    diffArgs = ['diff', ...plain, '--', scope]
    nameArgs = ['diff', '--name-only', '-z', '--', scope]
  } else {
    diffArgs = ['diff', ...plain, scope, 'HEAD']
    nameArgs = ['diff', '--name-only', '-z', scope, 'HEAD']
  }
  const [diff, files] = await Promise.all([
    git(ports, repo, diffArgs, DIFF_TIMEOUT_MS),
    git(ports, repo, nameArgs, DIFF_TIMEOUT_MS),
  ])
  // A non-zero exit is a real failure (bad ref, not a repo), never "no changes": an empty answer would read as clean.
  if (!diff.ok) return fail('diff', diff)
  if (!files.ok) return fail('diff --name-only', files)
  let text = diff.stdout
  let changed = names(files.stdout)
  if (!baseOid && scope === 'uncommitted') {
    const untracked = await untrackedDiff(ports, repo)
    text = [text, untracked.diff].filter((part) => part.trim()).join('\n')
    changed = [...changed, ...untracked.files]
  }
  return { diff: text, files: [...new Set(changed)] }
}

/** A review's clones, one directory per `prepare` step key; removes this one first so a retry starts clean. */
export function cloneDirFor(ports: ReviewPorts, key: string): { root: string; dir: string } {
  const root = join(ports.stateDir, CLONE_ROOT)
  return { root, dir: join(root, createHash('sha256').update(key).digest('hex').slice(0, 16)) }
}

/** Removes `dir` only when it is a child of the clone root: a wrong argument must never reach `rm -rf` elsewhere. */
export function removeClone(ports: ReviewPorts, dir: string): void {
  const root = join(ports.stateDir, CLONE_ROOT)
  if (!dir.startsWith(`${root}${sep}`)) throw new Error(`refusing to remove ${dir}: not under ${root}`)
  rmSync(dir, { recursive: true, force: true })
}

/** Clones left by a run that never reached its cleanup (a crash, a cancel). Best effort. */
export function sweepStaleClones(ports: ReviewPorts, keep?: string): string[] {
  const root = join(ports.stateDir, CLONE_ROOT)
  if (!existsSync(root)) return []
  const removed: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (path === keep || !entry.isDirectory()) continue
    try {
      if (ports.now() - statSync(path).mtimeMs < STALE_CLONE_MS) continue
      rmSync(path, { recursive: true, force: true })
      removed.push(path)
    } catch {
      // another run's cleanup won the race, or the directory is unreadable: next sweep
    }
  }
  return removed
}

const DEFAULT_BRANCH = /^ref: refs\/heads\/(\S+)\s+HEAD$/m

/**
 * A throwaway shared clone of `cwd`, with the PR or branch fetched from `cwd`'s origin and the default branch's tip as
 * the diff base. `cwd` is only read: nothing is fetched into it, no ref, worktree, HEAD or index of it changes.
 */
async function cloneForRef(
  ports: ReviewPorts,
  cwd: string,
  key: string,
  ref: { pr?: number; branch?: string },
): Promise<{ dir: string; baseOid: string } | { error: string }> {
  const { root, dir } = cloneDirFor(ports, key)
  mkdirSync(root, { recursive: true })
  rmSync(dir, { recursive: true, force: true })
  const what = ref.pr !== undefined ? `PR #${ref.pr}` : `branch ${ref.branch}`
  const origin = await git(ports, cwd, ['remote', 'get-url', 'origin'])
  if (!origin.ok || !origin.stdout.trim()) return { error: `${cwd} has no origin remote to fetch ${what} from` }
  const cloned = await git(
    ports,
    root,
    ['clone', '--quiet', '--shared', '--no-checkout', '--', cwd, dir],
    FETCH_TIMEOUT_MS,
  )
  if (!cloned.ok) return { error: `could not clone ${cwd}: ${tail(cloned.stderr)}` }
  const inClone = (args: string[], timeoutMs = GIT_TIMEOUT_MS) =>
    git(ports, dir, args, timeoutMs, { GIT_LFS_SKIP_SMUDGE: '1' })
  // The clone's own origin is `cwd`; the review fetches from the real one.
  await inClone(['remote', 'set-url', 'origin', origin.stdout.trim()])
  const tip = async (refspec: string): Promise<{ oid: string } | { error: string }> => {
    const fetched = await inClone(['fetch', '--quiet', 'origin', refspec], FETCH_TIMEOUT_MS)
    if (!fetched.ok) return { error: `could not fetch ${refspec} from origin: ${tail(fetched.stderr) || 'no output'}` }
    const resolved = await inClone(['rev-parse', '--verify', 'FETCH_HEAD^{commit}'])
    if (!resolved.ok || !resolved.stdout.trim()) return { error: `fetched ${refspec} but could not resolve it` }
    return { oid: resolved.stdout.trim() }
  }
  const head = await tip(ref.pr !== undefined ? `pull/${ref.pr}/head` : `refs/heads/${ref.branch}`)
  if ('error' in head) return head
  const symref = await inClone(['ls-remote', '--symref', 'origin', 'HEAD'])
  const defaultBranch = DEFAULT_BRANCH.exec(symref.stdout)?.[1]
  if (!defaultBranch)
    return { error: `could not read origin's default branch: ${tail(symref.stderr) || symref.stdout.trim()}` }
  const unsafe = branchProblem(defaultBranch)
  if (unsafe) return { error: `refusing origin's default branch "${defaultBranch}": ${unsafe}` }
  const base = await tip(`refs/heads/${defaultBranch}`)
  if ('error' in base) return base
  const checkout = await inClone(
    ['-c', 'core.hooksPath=/dev/null', 'checkout', '--quiet', '--detach', head.oid],
    FETCH_TIMEOUT_MS,
  )
  if (!checkout.ok) return { error: `could not check out ${what}: ${tail(checkout.stderr)}` }
  return { dir, baseOid: base.oid }
}

export async function runFallow(ports: ReviewPorts, repo: string, base: Base): Promise<string> {
  if (base.kind === 'skip' || !ports.which('fallow')) return ''
  if (base.kind === 'auto') {
    const remotes = await git(ports, repo, ['remote', '-v'])
    if (!remotes.stdout.trim()) return ''
  }
  const argv = ['fallow', 'review', '--brief', '--quiet', ...(base.kind === 'base' ? ['--base', base.ref] : [])]
  const r = await ports.exec(argv, { cwd: repo, timeoutMs: FALLOW_TIMEOUT_MS })
  if (r.timedOut) return `fallow failed (timed out after ${FALLOW_TIMEOUT_MS / 1000}s)`
  if (r.code !== 0) return `fallow failed (exit ${r.code ?? 'killed'}): ${tail(r.stderr)}`
  return r.stdout.trim()
}

function readPackageJson(repo: string): { scripts?: { test?: unknown } } | null {
  try {
    return JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as { scripts?: { test?: unknown } }
  } catch {
    return null
  }
}

/** Env switches, read once in `prepare` so a resumed run decides the same way. */
function switches(env: Env) {
  const minLines = Number(env.AGW_REVIEW_OCR_MIN_LINES)
  return {
    gating: env.AGW_REVIEW_DEPTH_GATING !== '0',
    adversary: env.AGW_REVIEW_ADVERSARY !== 'false',
    ocrEnabled: env.AGW_REVIEW_OCR !== '0',
    ocrMinLines: env.AGW_REVIEW_OCR_MIN_LINES?.trim() && Number.isFinite(minLines) && minLines >= 0 ? minLines : 100,
  }
}

/** OCR needs the `ocr` binary and the IU credentials its child process is handed. */
function ocrBlocker(ports: ReviewPorts): string | null {
  if (!ports.which('ocr')) return 'ocr not found on PATH'
  const key = ports.env.IU_API_KEY?.trim()
  const base = ports.env.IU_BASE_URL?.trim()
  if (!key || !base) return 'IU credentials unavailable: IU_API_KEY and IU_BASE_URL must be set'
  if (!base.replace(/\/+$/, '').endsWith('/anthropic'))
    return 'IU credentials unavailable: IU_BASE_URL does not end in /anthropic'
  return null
}

/**
 * The `prepare` step: validates the input against the machine, makes the throwaway clone for `pr`/`branch`, and gathers
 * the diff, the changed files, `package.json` and fallow's brief. An empty diff stops here: the caller answers `clean`.
 */
export async function prepare(
  input: { cwd: string; scope?: string; pr?: number; branch?: string },
  key: string,
  ports: ReviewPorts,
): Promise<PrepareResult> {
  const { cwd, pr, branch } = input
  try {
    if (!statSync(cwd).isDirectory()) return invalid(`cwd is not a directory: ${cwd}`)
  } catch {
    return invalid(`cwd does not exist: ${cwd}`)
  }
  const inside = await git(ports, cwd, ['rev-parse', '--is-inside-work-tree'])
  if (!inside.ok || inside.stdout.trim() !== 'true') return invalid(`cwd is not a git work tree: ${cwd}`)

  const refMode = pr !== undefined || branch !== undefined
  const label = refMode ? (pr !== undefined ? `pr:${pr}` : `branch:${branch}`) : (input.scope ?? 'uncommitted')
  sweepStaleClones(ports, cloneDirFor(ports, key).dir)

  let repo = cwd
  let clone: string | null = null
  let baseOid: string | null = null
  if (refMode) {
    const made = await cloneForRef(ports, cwd, key, { pr, branch })
    if ('error' in made) {
      removeClone(ports, cloneDirFor(ports, key).dir)
      return failure(made.error)
    }
    repo = made.dir
    clone = made.dir
    baseOid = made.baseOid
  }

  const scope = refMode ? label : (input.scope ?? 'uncommitted')
  const found = await changesFor(ports, repo, scope, baseOid)
  const config = switches(ports.env)
  const base: Base = baseOid ? { kind: 'base', ref: baseOid } : baseFor(scope)
  const common = {
    repo,
    clone,
    label,
    base,
    ocr: ocrModeFor(scope, baseOid),
    ...config,
    ocrBlocker: ocrBlocker(ports),
  }
  if ('error' in found) {
    if (clone) removeClone(ports, clone)
    return found.kind === 'invalid_input' ? invalid(found.error) : failure(found.error)
  }
  if (!found.diff.trim()) {
    return { ok: true, ...common, diff: '', files: [], changedLines: 0, hasTestScript: false, fallow: '' }
  }
  const fallow = await runFallow(ports, repo, base)
  const pkg = readPackageJson(repo)
  return {
    ok: true,
    ...common,
    diff: found.diff,
    files: found.files,
    changedLines: countChangedLines(found.diff),
    hasTestScript: Boolean(pkg?.scripts?.test),
    fallow,
  }
}
