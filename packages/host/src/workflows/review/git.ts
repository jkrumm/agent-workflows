import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Exec } from './exec.ts'
import { networkEnv, tail } from './exec.ts'
import { mapLimit } from './util.ts'
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
  /** The repository root (`git rev-parse --show-toplevel`, realpath'd): one spelling for the prompts, the grant and the clone source. */
  cwd: string
  /** The subdirectory the review was started in when that is not the root: the review covers the whole repository. */
  invokedIn: string | null
  /** The directory the agents and tools read: `cwd`, or the throwaway clone of a `pr`/`branch` review. */
  repo: string
  /** The clone to remove when the run ends; null when `repo` is the caller's own checkout. */
  clone: string | null
  /** The commits a `pr`/`branch` review compares, journaled so a clone swept before a resume is rebuilt at the same state. */
  headOid: string | null
  baseOid: string | null
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

export type ScopeKind = 'uncommitted' | 'head' | 'range' | 'ref' | 'path'

/** A scope that git resolves as a commit is a ref (`v2.0`); only what it does not resolve is a path. */
export function kindOf(scope: string, resolvesAsCommit: boolean): ScopeKind {
  if (scope === 'uncommitted' || scope === 'head') return scope
  if (splitRange(scope)) return 'range'
  return resolvesAsCommit ? 'ref' : 'path'
}

const lexicalKind = (scope: string): ScopeKind => kindOf(scope, !isPathScope(scope))

/** `fallow review --base <ref>` always reviews `<ref>...HEAD`: a range ending elsewhere has no equivalent, so it skips. */
export function baseFor(scope: string, kind: ScopeKind = lexicalKind(scope)): Base {
  if (scope === 'uncommitted') return { kind: 'base', ref: 'HEAD' }
  if (scope === 'head') return { kind: 'base', ref: 'HEAD~1' }
  const range = splitRange(scope)
  if (range) {
    if (!range.from) return { kind: 'skip' }
    if (range.to && range.to !== 'HEAD') return { kind: 'skip' }
    return { kind: 'base', ref: range.from }
  }
  if (kind === 'path') return { kind: 'auto' }
  return { kind: 'base', ref: scope }
}

/** `ocr review`'s mode for a scope; null when it has none (a file path, an open-ended range). */
export function ocrModeFor(
  scope: string,
  baseOid: string | null,
  kind: ScopeKind = lexicalKind(scope),
): OcrMode | null {
  if (baseOid) return { mode: 'range', from: baseOid, to: 'HEAD' }
  if (scope === 'uncommitted') return { mode: 'uncommitted', from: null, to: null }
  if (scope === 'head') return { mode: 'head', from: null, to: null }
  const range = splitRange(scope)
  if (range) return range.from ? { mode: 'range', from: range.from, to: range.to || 'HEAD' } : null
  if (kind === 'path') return null
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

/** Untracked, non-ignored files as added-file hunks, without touching the caller's index (`git add -N` would). */
async function untrackedDiff(
  ports: ReviewPorts,
  repo: string,
  pathspec?: string,
): Promise<{ diff: string; files: string[] }> {
  const listed = await git(ports, repo, [
    'ls-files',
    '--others',
    '--exclude-standard',
    '-z',
    ...(pathspec ? ['--', pathspec] : []),
  ])
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
async function changesFor(
  ports: ReviewPorts,
  repo: string,
  scope: string,
  baseOid: string | null,
  kind: ScopeKind,
  pathspec: string,
): Promise<Changes> {
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
  } else if (scope === 'uncommitted' || kind === 'path') {
    // Staged and unstaged together; a path scope is the same, narrowed to the path (a staged or new file is never "no change").
    const hasHead = (await git(ports, repo, ['rev-parse', '--verify', '--quiet', 'HEAD'])).ok
    const against = hasHead ? ['HEAD'] : ['--cached']
    const narrow = kind === 'path' ? ['--', pathspec] : []
    diffArgs = ['diff', ...plain, ...against, ...narrow]
    nameArgs = ['diff', '--name-only', '-z', ...against, ...narrow]
  } else if (scope === 'head') {
    diffArgs = ['show', ...plain, 'HEAD']
    nameArgs = ['show', 'HEAD', '--name-only', '-z', '--format=']
  } else if (kind === 'range') {
    diffArgs = ['diff', ...plain, scope]
    nameArgs = ['diff', '--name-only', '-z', scope]
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
  if (!baseOid && (scope === 'uncommitted' || kind === 'path')) {
    const untracked = await untrackedDiff(ports, repo, kind === 'path' ? pathspec : undefined)
    text = [text, untracked.diff].filter((part) => part.trim()).join('\n')
    changed = [...changed, ...untracked.files]
  }
  return { diff: text, files: [...new Set(changed)] }
}

/**
 * The pathspec git gets for a path scope: relative to the root it runs in, `.` for the root itself (an empty string is
 * not a pathspec). A relative scope is relative to where the caller stood; an absolute one is checked against the root
 * (both realpath'd). Null when it is outside the repository. A scope that starts with `:` is git's pathspec magic and
 * passes through untouched.
 */
export function pathspecFor(scope: string, invoked: string, root: string): string | null {
  if (scope.startsWith(':')) return scope
  const absolute = isAbsolute(scope) ? scope : resolve(invoked, scope)
  let real: string
  try {
    // The directory is resolved, the last component is not: a tracked symlink is itself the path under review.
    real = join(realpathSync(dirname(absolute)), basename(absolute))
  } catch {
    real = absolute
  }
  const rel = relative(root, real)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null
  return rel === '' ? '.' : rel
}

const GLOB_OR_CONTROL = /[*?[\]{}\p{Cc}\u2028\u2029]/u

/** The clone root, realpath'd (the agents' grant matches the path as given, so one spelling must be used everywhere). */
function cloneRoot(ports: ReviewPorts, create: boolean): string {
  const root = join(ports.stateDir, CLONE_ROOT)
  if (create) mkdirSync(root, { recursive: true })
  return existsSync(root) ? realpathSync(root) : root
}

/** A review's clones, one directory per `prepare` step key: deterministic, so a resumed run finds (or rebuilds) the same path. */
export function cloneDirFor(ports: ReviewPorts, key: string): { root: string; dir: string } {
  const root = cloneRoot(ports, false)
  return { root, dir: join(root, createHash('sha256').update(key).digest('hex').slice(0, 16)) }
}

/** Removes `dir` only when it is a child of the clone root: a wrong argument must never reach `rm -rf` elsewhere. */
export function removeClone(ports: ReviewPorts, dir: string): void {
  const root = cloneRoot(ports, false)
  if (!dir.startsWith(`${root}${sep}`)) throw new Error(`refusing to remove ${dir}: not under ${root}`)
  rmSync(dir, { recursive: true, force: true })
}

/** Clones left by a run that never reached its cleanup (a crash, a cancel). Best effort. */
export function sweepStaleClones(ports: ReviewPorts, keep?: string): string[] {
  const root = cloneRoot(ports, false)
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

/**
 * Deletes every symlink whose target leaves `root` (a dangling one is judged by where it points lexically). The agents'
 * `external_directory` grant matches the path they name, not where a link leads, so a `link -> ~` in an untrusted PR would
 * be a read of the whole home directory. Only for a throwaway clone: the caller's own checkout is never edited.
 */
export function removeEscapingSymlinks(root: string): string[] {
  const realRoot = realpathSync(root)
  const removed: string[] = []
  const inside = (path: string) => path === realRoot || path.startsWith(`${realRoot}${sep}`)
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (dir === root && entry.name === '.git') continue
      const path = join(dir, entry.name)
      if (entry.isSymbolicLink()) {
        let stays: boolean
        try {
          stays = inside(realpathSync(path))
        } catch {
          stays = inside(resolve(realRoot, relative(root, dirname(path)), readlinkSync(path)))
        }
        if (!stays) {
          rmSync(path, { force: true })
          removed.push(relative(root, path))
        }
      } else if (entry.isDirectory()) {
        walk(path)
      }
    }
  }
  walk(root)
  return removed
}

const DEFAULT_BRANCH = /^ref: refs\/heads\/(\S+)\s+HEAD$/m

/**
 * A throwaway shared clone of `cwd`, with the PR or branch fetched from `cwd`'s origin and the default branch's tip as
 * the diff base. `cwd` is only read: nothing is fetched into it, no ref, worktree, HEAD or index of it changes. With
 * `expected` (a resume whose clone was swept) the same two commits are fetched again, by id when a ref has moved on.
 */
async function cloneForRefUnsafe(
  ports: ReviewPorts,
  cwd: string,
  key: string,
  ref: { pr?: number; branch?: string },
  expected?: { headOid: string; baseOid: string },
): Promise<{ dir: string; headOid: string; baseOid: string } | { error: string }> {
  const root = cloneRoot(ports, true)
  const { dir } = cloneDirFor(ports, key)
  if (GLOB_OR_CONTROL.test(dir)) return { error: `the clone path contains glob or control characters: ${dir}` }
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
  // Only `fetch` and `ls-remote` get the credential-carrying variables; the rest of the clone's git work does not.
  const inClone = (args: string[], timeoutMs = GIT_TIMEOUT_MS, net = false) =>
    git(ports, dir, args, timeoutMs, { GIT_LFS_SKIP_SMUDGE: '1', ...(net ? networkEnv(ports.env) : {}) })
  // The clone's own origin is `cwd`; the review fetches from the real one.
  await inClone(['remote', 'set-url', 'origin', origin.stdout.trim()])
  const tip = async (refspec: string, want?: string): Promise<{ oid: string } | { error: string }> => {
    const fetchOne = async (spec: string) => {
      const fetched = await inClone(['fetch', '--quiet', 'origin', spec], FETCH_TIMEOUT_MS, true)
      if (!fetched.ok) return { error: `could not fetch ${spec} from origin: ${tail(fetched.stderr) || 'no output'}` }
      const resolved = await inClone(['rev-parse', '--verify', 'FETCH_HEAD^{commit}'])
      if (!resolved.ok || !resolved.stdout.trim()) return { error: `fetched ${spec} but could not resolve it` }
      return { oid: resolved.stdout.trim() }
    }
    const got = await fetchOne(refspec)
    if (!want || ('oid' in got && got.oid === want)) return got
    // The ref moved since the review began: the journaled diff belongs to the commit it was made on.
    const exact = await fetchOne(want)
    return 'oid' in exact && exact.oid === want
      ? exact
      : { error: `${refspec} moved on and ${want} cannot be fetched again` }
  }
  const head = await tip(ref.pr !== undefined ? `pull/${ref.pr}/head` : `refs/heads/${ref.branch}`, expected?.headOid)
  if ('error' in head) return head
  const symref = await inClone(['ls-remote', '--symref', 'origin', 'HEAD'], GIT_TIMEOUT_MS, true)
  const defaultBranch = DEFAULT_BRANCH.exec(symref.stdout)?.[1]
  if (!defaultBranch)
    return { error: `could not read origin's default branch: ${tail(symref.stderr) || symref.stdout.trim()}` }
  const unsafe = branchProblem(defaultBranch)
  if (unsafe) return { error: `refusing origin's default branch "${defaultBranch}": ${unsafe}` }
  const base = await tip(`refs/heads/${defaultBranch}`, expected?.baseOid)
  if ('error' in base) return base
  const checkout = await inClone(
    ['-c', 'core.hooksPath=/dev/null', 'checkout', '--quiet', '--detach', head.oid],
    FETCH_TIMEOUT_MS,
  )
  if (!checkout.ok) return { error: `could not check out ${what}: ${tail(checkout.stderr)}` }
  removeEscapingSymlinks(dir)
  return { dir, headOid: head.oid, baseOid: base.oid }
}

/** `cloneForRefUnsafe`; whatever it throws after the clone exists removes the clone and comes back as the error. */
async function cloneForRef(
  ports: ReviewPorts,
  cwd: string,
  key: string,
  ref: { pr?: number; branch?: string },
  expected?: { headOid: string; baseOid: string },
): Promise<{ dir: string; headOid: string; baseOid: string } | { error: string }> {
  try {
    const made = await cloneForRefUnsafe(ports, cwd, key, ref, expected)
    // Every way to fail (a fetch, a ref that moved on, no default branch, a checkout) leaves a half-built clone behind.
    if ('error' in made) discardClone(ports, key)
    return made
  } catch (error) {
    discardClone(ports, key)
    return { error: `cloning failed: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/** Best effort: the clone of this step key, if any exists. */
function discardClone(ports: ReviewPorts, key: string): void {
  try {
    removeClone(ports, cloneDirFor(ports, key).dir) // through the root guard, never a raw rm
  } catch {
    // the next prepare's sweep takes what is left
  }
}

/**
 * On a replay the journaled `prepare` result says where the clone is; if a sweep (or anything else) removed it since, it
 * is rebuilt at the same path from the same two commits before any step reads it. Returns an error message, or null.
 */
export async function restoreClone(
  ports: ReviewPorts,
  p: Prepared,
  ref: { pr?: number; branch?: string },
  key: string,
): Promise<string | null> {
  if (!p.clone || existsSync(p.clone)) return null
  if (!p.headOid || !p.baseOid)
    return `the review clone ${p.clone} is gone and no commit ids were journaled to rebuild it`
  const made = await cloneForRef(ports, p.cwd, key, ref, { headOid: p.headOid, baseOid: p.baseOid })
  if ('error' in made) return `the review clone ${p.clone} is gone and could not be rebuilt: ${made.error}`
  return made.dir === p.clone ? null : `the rebuilt clone is at ${made.dir}, not ${p.clone}`
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

/** OCR is opt-in (owner pause, open-ended): on only for an exact `1`. The parent and `runOcr` both ask, so a stale journal cannot start it. */
export function ocrSwitchOn(env: Env): boolean {
  return env.AGW_REVIEW_OCR?.trim() === '1'
}

/** Env switches, read once in `prepare` so a resumed run decides the same way. */
function switches(env: Env) {
  const minLines = Number(env.AGW_REVIEW_OCR_MIN_LINES)
  return {
    gating: env.AGW_REVIEW_DEPTH_GATING !== '0',
    adversary: env.AGW_REVIEW_ADVERSARY !== 'false',
    ocrEnabled: ocrSwitchOn(env),
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
  try {
    return await prepareChecked(input, key, ports)
  } catch (error) {
    // Anything thrown after the clone exists: the clone goes, and the run gets an error, not a leaked directory.
    discardClone(ports, key)
    return failure(`review prepare failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function prepareChecked(
  input: { cwd: string; scope?: string; pr?: number; branch?: string },
  key: string,
  ports: ReviewPorts,
): Promise<PrepareResult> {
  const { pr, branch } = input
  let invoked: string
  try {
    if (!statSync(input.cwd).isDirectory()) return invalid(`cwd is not a directory: ${input.cwd}`)
    invoked = realpathSync(input.cwd)
  } catch {
    return invalid(`cwd does not exist: ${input.cwd}`)
  }
  const inside = await git(ports, invoked, ['rev-parse', '--is-inside-work-tree'])
  if (!inside.ok || inside.stdout.trim() !== 'true') return invalid(`cwd is not a git work tree: ${invoked}`)
  // One spelling of the repository root for everything that follows: the prompts, the agents' grant and the clone
  // source. A subdirectory reviews the whole repository (a diff is repo-wide), and the prompts say so.
  const top = await git(ports, invoked, ['rev-parse', '--show-toplevel'])
  if (!top.ok || !top.stdout.trim()) return invalid(`cwd is not a git work tree: ${invoked}`)
  const cwd = realpathSync(top.stdout.trim())
  const invokedIn = cwd === invoked ? null : invoked
  // The agents' grant is a glob on this path: a wildcard in it would widen the grant, a control character would forge a prompt line.
  for (const path of [cwd, invoked]) {
    if (GLOB_OR_CONTROL.test(path)) return invalid(`cwd contains glob or control characters: ${JSON.stringify(path)}`)
  }

  const refMode = pr !== undefined || branch !== undefined
  const label = refMode ? (pr !== undefined ? `pr:${pr}` : `branch:${branch}`) : (input.scope ?? 'uncommitted')
  const scope = label
  // A scope git resolves as a commit is a ref (`v2.0`); what it does not resolve is a path, and a path must exist.
  let kind: ScopeKind = 'range'
  let pathspec = scope
  if (!refMode) {
    const resolves =
      scope === 'uncommitted' || scope === 'head' || splitRange(scope)
        ? false
        : (await git(ports, invoked, ['rev-parse', '--verify', '--quiet', `${scope}^{commit}`])).ok
    kind = kindOf(scope, resolves)
    if (kind === 'path') {
      const spec = pathspecFor(scope, invoked, cwd)
      if (spec === null) return invalid(`scope "${scope}" is outside the repository`)
      pathspec = spec
      const matched = await git(ports, cwd, [
        'ls-files',
        '-z',
        '--cached',
        '--others',
        '--exclude-standard',
        '--',
        pathspec,
      ])
      if (!matched.ok || names(matched.stdout).length === 0) {
        return invalid(`scope "${scope}" is neither a git ref nor a file in the work tree`)
      }
    }
  }
  sweepStaleClones(ports, cloneDirFor(ports, key).dir)

  let repo = cwd
  let clone: string | null = null
  let headOid: string | null = null
  let baseOid: string | null = null
  if (refMode) {
    const made = await cloneForRef(ports, cwd, key, { pr, branch })
    if ('error' in made) {
      discardClone(ports, key)
      return failure(made.error)
    }
    repo = made.dir
    clone = made.dir
    headOid = made.headOid
    baseOid = made.baseOid
  }

  const found = await changesFor(ports, repo, scope, baseOid, kind, pathspec)
  const config = switches(ports.env)
  const base: Base = baseOid ? { kind: 'base', ref: baseOid } : baseFor(scope, kind)
  const common = {
    cwd,
    invokedIn: refMode ? null : invokedIn, // a clone is of the whole repository: there is no subdirectory to name
    repo,
    clone,
    headOid,
    baseOid,
    label,
    base,
    ocr: ocrModeFor(scope, baseOid, kind),
    ...config,
    ocrBlocker: ocrBlocker(ports),
  }
  if ('error' in found) {
    discardClone(ports, key)
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
