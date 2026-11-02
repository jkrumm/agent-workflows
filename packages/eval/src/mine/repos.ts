import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { EXCLUDED_REPOS } from './version.ts'

export interface MineRepo {
  /** `SourceRoot/<dir>`: the `GtRepo` name. */
  name: string
  dir: string
  path: string
}

/**
 * Every direct child of `root` that is a git checkout (a `.git` directory: a linked worktree has a `.git` file and a
 * nested repo is not a child), minus the excluded names and anything starting with `.`. Sorted by name.
 */
export function discoverRepos(root: string, excluded: readonly string[] = EXCLUDED_REPOS): MineRepo[] {
  if (!existsSync(root)) return []
  return readdirSync(root)
    .filter((dir) => !dir.startsWith('.') && !excluded.includes(dir))
    .sort()
    .flatMap((dir) => {
      const path = join(root, dir)
      const git = join(path, '.git')
      return existsSync(git) && statSync(git).isDirectory() ? [{ name: `SourceRoot/${dir}`, dir, path }] : []
    })
}
