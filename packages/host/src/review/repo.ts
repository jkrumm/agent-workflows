// Where a review's commits come from: the caller's toplevel, the repo identity, the scope's base and head (an uncommitted
// change becomes a snapshot commit), and the thread. The caller's index, HEAD, refs and work tree are never written.
import { createHash, randomBytes } from 'node:crypto'
import { realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { type Exec, tail } from '../process.ts'
import { cloneForRef, removeClone, type ReviewPorts } from './clone.ts'
import { branchProblem, scopeProblem, splitRange } from './scope.ts'
import type { GitRunner } from './route.ts'
import { ReviewError } from './schema.ts'

const GIT_TIMEOUT_MS = 60_000
const AGW_IDENTITY = {
  GIT_AUTHOR_NAME: 'agw',
  GIT_AUTHOR_EMAIL: 'agw@localhost',
  GIT_COMMITTER_NAME: 'agw',
  GIT_COMMITTER_EMAIL: 'agw@localhost',
}

/** stdout, or null when git exits non-zero (a missing object, a failed ancestry test). */
export const tryGit = (git: GitRunner, cwd: string, args: string[]): Promise<string | null> =>
  git(cwd, args).catch(() => null)

export const isAncestor = async (git: GitRunner, cwd: string, a: string, b: string): Promise<boolean> =>
  (await tryGit(git, cwd, ['merge-base', '--is-ancestor', a, b])) !== null

const commitOf = async (git: GitRunner, cwd: string, ref: string): Promise<string> => {
  const out = await tryGit(git, cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
  if (!out?.trim()) throw new ReviewError(`"${ref}" is not a commit in ${cwd}`)
  return out.trim()
}

/** The realpath of the toplevel of the work tree `cwd` is in. */
export async function resolveRoot(git: GitRunner, cwd: string): Promise<string> {
  let invoked: string
  try {
    if (!statSync(cwd).isDirectory()) throw new ReviewError(`cwd is not a directory: ${cwd}`)
    invoked = realpathSync(cwd)
  } catch (error) {
    if (error instanceof ReviewError) throw error
    throw new ReviewError(`cwd does not exist: ${cwd}`)
  }
  const top = await tryGit(git, invoked, ['rev-parse', '--show-toplevel'])
  if (!top?.trim()) throw new ReviewError(`cwd is not a git work tree: ${invoked}`)
  return realpathSync(top.trim())
}

/** `https://user:pw@github.com/o/n.git`, `git@github.com:o/n.git`, `ssh://git@github.com/o/n` → `github.com/o/n`. */
export function normalizeOrigin(url: string): string | null {
  let rest = url.trim()
  if (!rest) return null
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(rest)
  if (scheme) {
    if (rest.toLowerCase().startsWith('file://')) return null
    rest = rest.slice(scheme[0].length)
  } else {
    // scp-like `user@host:path`; a local path is not an identity of its own
    const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(rest)
    if (!scp) return null
    rest = `${scp[1]}/${scp[2]}`
  }
  rest = rest.replace(/^[^@/]*@/, '') // credentials
  const slash = rest.indexOf('/')
  if (slash <= 0) return null
  const host = rest.slice(0, slash).toLowerCase().replace(/:\d+$/, '')
  const path = rest
    .slice(slash + 1)
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
  return path ? `${host}/${path}` : null
}

/** One identity for every worktree and clone of a repo: its origin, else the main worktree's toplevel. */
export async function repoIdentity(git: GitRunner, root: string): Promise<string> {
  const origin = await tryGit(git, root, ['remote', 'get-url', 'origin'])
  const normalized = origin ? normalizeOrigin(origin) : null
  if (normalized) return normalized
  const common = (await git(root, ['rev-parse', '--git-common-dir'])).trim()
  const abs = isAbsolute(common) ? common : resolve(root, common)
  return realpathSync(dirname(realpathSync(abs)))
}

export const threadId = (repo: string, key: string): string =>
  createHash('sha256').update(`${repo}\0${key}`).digest('hex').slice(0, 12)

/**
 * The work tree's changes as a commit on HEAD, through a temporary index: only unreferenced objects land in the
 * caller's object store. No change against HEAD → HEAD itself (an empty diff).
 */
export async function snapshot(exec: Exec, root: string): Promise<{ head: string; snapshot: boolean }> {
  const index = join(tmpdir(), `agw-review-index-${randomBytes(8).toString('hex')}`)
  const run = async (args: string[], env: Record<string, string> = {}) => {
    const r = await exec(['git', ...args], {
      cwd: root,
      timeoutMs: GIT_TIMEOUT_MS,
      env: { GIT_INDEX_FILE: index, ...env },
    })
    if (r.code !== 0) throw new ReviewError(`snapshot: git ${args[0]} failed: ${tail(r.stderr) || `exit ${r.code}`}`)
    return r.stdout.trim()
  }
  try {
    const head = await run(['rev-parse', '--verify', 'HEAD^{commit}'])
    await run(['read-tree', 'HEAD'])
    await run(['add', '-A'])
    const tree = await run(['write-tree'])
    if (tree === (await run(['rev-parse', 'HEAD^{tree}']))) return { head, snapshot: false }
    const commit = await run(['commit-tree', tree, '-p', head, '-m', 'agw review snapshot'], AGW_IDENTITY)
    return { head: commit, snapshot: true }
  } finally {
    rmSync(index, { force: true })
    rmSync(`${index}.lock`, { force: true })
  }
}

export type ScopeRequest = { scope?: string; pr?: number; branch?: string }

export interface ResolvedScope {
  /** Where base and head live: the caller's toplevel, or the review clone of a pr/branch. */
  gitDir: string
  base: string
  head: string
  snapshot: boolean
  /** The thread key without `--thread`. */
  key: string
  /** One line for intent.md. */
  label: string
  /** pr/branch: the review clone, already checked out at head. */
  clone: string | null
}

/** The scope's base and head. pr/branch fetch into a throwaway clone (`cloneForRef`, keyed by `cloneKey`). */
export async function resolveScope(
  ports: { git: GitRunner; exec: Exec; clonePorts: ReviewPorts },
  root: string,
  request: ScopeRequest,
  cloneKey: string,
): Promise<ResolvedScope> {
  const { git } = ports
  const { pr, branch } = request
  if (pr !== undefined && branch !== undefined) throw new ReviewError('`pr` and `branch` are mutually exclusive')
  if ((pr !== undefined || branch !== undefined) && request.scope !== undefined) {
    throw new ReviewError('`scope` must be omitted with `pr` or `branch`')
  }
  if (pr !== undefined || branch !== undefined) {
    const unsafe = branch === undefined ? null : branchProblem(branch)
    if (unsafe) throw new ReviewError(`invalid branch: ${unsafe}`)
    const made = await cloneForRef(ports.clonePorts, root, cloneKey, pr !== undefined ? { pr } : { branch })
    if ('error' in made) throw new ReviewError(made.error)
    const mergeBase = await tryGit(git, made.dir, ['merge-base', made.baseOid, made.headOid])
    if (!mergeBase?.trim()) {
      removeClone(ports.clonePorts, made.dir)
      throw new ReviewError(`no merge base between ${made.headOid} and origin's default branch`)
    }
    const what = pr !== undefined ? `pr:${pr}` : `branch:${branch}`
    return {
      gitDir: made.dir,
      base: mergeBase.trim(),
      head: made.headOid,
      snapshot: false,
      key: what,
      label:
        pr !== undefined
          ? `Scope: pull request #${pr} against origin's default branch`
          : `Scope: branch ${branch} against origin's default branch`,
      clone: made.dir,
    }
  }

  const scope = request.scope ?? 'uncommitted'
  const problem = scopeProblem(scope)
  if (problem) throw new ReviewError(`invalid scope: ${problem}`)
  const at = (base: string, head: string, label: string, snap = false): ResolvedScope => ({
    gitDir: root,
    base,
    head,
    snapshot: snap,
    key: `base:${base}`,
    label,
    clone: null,
  })
  if (scope === 'uncommitted') {
    const base = await commitOf(git, root, 'HEAD')
    const snap = await snapshot(ports.exec, root)
    return at(base, snap.head, `Scope: uncommitted changes on ${base.slice(0, 12)}`, snap.snapshot)
  }
  if (scope === 'head') {
    return at(await commitOf(git, root, 'HEAD~1'), await commitOf(git, root, 'HEAD'), 'Scope: the last commit')
  }
  const range = splitRange(scope)
  if (range) {
    const base = await commitOf(git, root, range.from || 'HEAD')
    return at(base, await commitOf(git, root, range.to || 'HEAD'), `Scope: ${scope}`)
  }
  const ref = await commitOf(git, root, scope)
  const head = await commitOf(git, root, 'HEAD')
  const mergeBase = await tryGit(git, root, ['merge-base', ref, head])
  if (!mergeBase?.trim()) throw new ReviewError(`no merge base between ${scope} and HEAD`)
  return at(mergeBase.trim(), head, `Scope: ${scope}..HEAD`)
}
