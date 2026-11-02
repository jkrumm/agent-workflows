import type { Exec } from '../harness/exec.ts'

/** A helper bound: a git call that outlives it is stuck, not slow. */
const GIT_TIMEOUT_MS = 10 * 60_000

/** A read-only git call in `repo`; throws with git's own words on a non-zero exit. */
export type Git = (args: string[]) => Promise<string>

export function gitIn(exec: Exec, repo: string): Git {
  return async (args) => {
    const result = await exec('git', ['-C', repo, '-c', 'core.quotepath=off', ...args], {
      env: { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
      timeoutMs: GIT_TIMEOUT_MS,
    })
    if (result.code !== 0) throw new Error(`git ${args.slice(0, 3).join(' ')}: ${result.stderr.trim().slice(0, 300)}`)
    return result.stdout
  }
}

/** One commit of `git log`, with the files it changed (`numstat`, binaries excluded from the line counts). */
export interface LogCommit {
  sha: string
  parents: string[]
  email: string
  /** Author date, epoch seconds. */
  at: number
  /** Author date, ISO 8601 with offset. */
  iso: string
  subject: string
  files: string[]
  /** Added plus deleted lines over the text files. */
  changed: number
}

const COMMIT_MARK = '\x01'
const FIELD = '\x02'

/** `old => new` and `dir/{old => new}/f` numstat paths to the path after the change. */
export function renameTarget(path: string): string {
  if (!path.includes(' => ')) return path
  if (!path.includes('{')) return path.slice(path.indexOf(' => ') + 4)
  return path.replace(/\{[^{}]* => ([^{}]*)\}/, '$1').replace(/\/{2,}/g, '/')
}

/**
 * Every non-merge commit reachable from HEAD with its numstat: one `git log`, which also gives the introducing-commit
 * sizes, the controls' sizes and (with `ignoreWhitespace`) the whitespace-free sizes the reformat rule compares.
 */
export async function readLog(git: Git, options: { ignoreWhitespace?: boolean } = {}): Promise<LogCommit[]> {
  const out = await git([
    'log',
    '--no-merges',
    '--find-renames',
    '--numstat',
    ...(options.ignoreWhitespace ? ['-w'] : []),
    `--format=${COMMIT_MARK}%H${FIELD}%P${FIELD}%ae${FIELD}%at${FIELD}%aI${FIELD}%s`,
  ])
  const commits: LogCommit[] = []
  for (const block of out.split(COMMIT_MARK)) {
    if (!block.trim()) continue
    const newline = block.indexOf('\n')
    const header = newline < 0 ? block : block.slice(0, newline)
    const [sha, parents, email, at, iso, ...subject] = header.split(FIELD)
    if (!sha || !iso) continue
    const files: string[] = []
    let changed = 0
    for (const line of newline < 0 ? [] : block.slice(newline + 1).split('\n')) {
      const [added, deleted, ...path] = line.split('\t')
      if (path.length === 0 || !added || !deleted) continue
      files.push(renameTarget(path.join('\t')))
      if (added !== '-') changed += Number(added) + Number(deleted)
    }
    commits.push({
      sha,
      parents: parents ? parents.split(' ') : [],
      email: (email ?? '').toLowerCase(),
      at: Number(at),
      iso,
      subject: subject.join(FIELD),
      files,
      changed,
    })
  }
  return commits
}
