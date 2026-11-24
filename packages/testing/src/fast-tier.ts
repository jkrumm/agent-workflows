import { spawnSync } from 'node:child_process'

/**
 * The fast tier of `make check-fast`: which of the repo's tests a lead runs locally for a branch. CI runs the full gate
 * (`make check`) on the pull request head, so the local tier only has to catch what the branch broke early.
 *
 * - `none`: every changed path is test-inert (docs, top-level markdown): no test reads them.
 * - `changed`: every changed path is TypeScript under a package: `bun test --changed` runs the test files whose import graph
 *   reaches one. A change that only a spawned process or a file read reaches is not in that graph, which is why CI stays the gate.
 * - `full`: anything else (a script, a template, JSON or markdown a package reads, the test support, lockfile, config), a path
 *   git does not track yet, or no base to diff against: the whole suite, as `make check`.
 */
export type Selection = { mode: 'none' } | { mode: 'changed'; base: string } | { mode: 'full'; reason: string }

const INERT = [/^docs\//, /^[^/]+\.md$/]
const SELECTABLE = /^packages\/(?!testing\/)[^/]+\/.+\.ts$/

/** The selection for the changed paths against `base`; `untracked` is the paths git does not track yet. */
export function select(input: { base: string | null; changed: string[]; untracked: string[] }): Selection {
  if (input.base === null) return { mode: 'full', reason: 'no merge base with origin/master' }
  if (input.untracked.length > 0) return { mode: 'full', reason: `untracked: ${input.untracked[0]}` }
  const live = input.changed.filter((path) => !INERT.some((pattern) => pattern.test(path)))
  if (live.length === 0) return { mode: 'none' }
  const outside = live.find((path) => !SELECTABLE.test(path))
  if (outside !== undefined) return { mode: 'full', reason: `${outside} is outside the import graph` }
  return { mode: 'changed', base: input.base }
}

function git(args: string[]): string | null {
  const proc = spawnSync('git', args, { encoding: 'utf8' })
  return proc.status === 0 ? proc.stdout.trim() : null
}

/** The selection for this checkout: its merge base with origin/master, what differs from it and what is untracked. */
export function selectHere(): Selection {
  const base = git(['merge-base', 'HEAD', 'origin/master'])
  const changed = base ? git(['diff', '--name-only', base]) : null
  const untracked = git(['ls-files', '--others', '--exclude-standard'])
  if (!base || changed === null || untracked === null) return select({ base: null, changed: [], untracked: [] })
  return select({
    base,
    changed: changed.split('\n').filter(Boolean),
    untracked: untracked.split('\n').filter(Boolean),
  })
}

// `bun packages/testing/src/fast-tier.ts`, run by `make test-fast`: one line, `none`, `changed <base sha>` or `full <reason>`.
if (import.meta.main) {
  const selection = selectHere()
  console.log(
    selection.mode === 'changed'
      ? `changed ${selection.base}`
      : selection.mode === 'full'
        ? `full ${selection.reason}`
        : 'none',
  )
}
