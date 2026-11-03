import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { type Env, type Exec, networkEnv, tail } from '../process.ts'
import { branchProblem } from './scope.ts'

/** What the review needs from the machine; every part defaults inside `createReviewService` and tests replace it. */
export type ReviewPorts = {
  exec: Exec
  env: Env
  /** The host state directory; throwaway clones live under `<stateDir>/review-clones/`. */
  stateDir: string
  now: () => number
}

const GIT_TIMEOUT_MS = 30_000
const FETCH_TIMEOUT_MS = 120_000
export const CLONE_ROOT = 'review-clones'
/** A clone older than this is a crashed run's: the next prepare removes it. */
const STALE_CLONE_MS = 24 * 3_600_000

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

const GLOB_OR_CONTROL = /[*?[\]{}\p{Cc}\u2028\u2029]/u

/** The clone root, realpath'd (the reviewer's grant matches the path as given, so one spelling must be used everywhere). */
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
export async function cloneForRef(
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
