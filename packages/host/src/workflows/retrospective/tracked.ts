import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

/** The files tracked in this repository, and the directories that hold them. */
export class TrackedPaths {
  private readonly files: Set<string>
  private readonly dirs = new Set<string>()

  constructor(files: Iterable<string>) {
    this.files = new Set(files)
    for (const file of this.files) {
      const parts = file.split('/')
      for (let i = 1; i < parts.length; i++) this.dirs.add(parts.slice(0, i).join('/'))
    }
  }

  get size() {
    return this.files.size
  }

  /** A tracked file, or a directory containing one. Exact match: no normalising, no globs. */
  has(path: string): boolean {
    return this.files.has(path) || this.dirs.has(path)
  }
}

const SKIPPED_DIRS = new Set(['node_modules', '.git'])
const GIT_WALL_MS = 30_000

/**
 * What the deploy ships is what git tracks: `make deploy` exports the commit with `git archive` into a release
 * directory, then installs `node_modules` beside it. A release has no `.git`, so its tree minus `node_modules` is the
 * tracked list; a dev checkout asks git. The list is read once per host process (a release never changes).
 */
export async function listTrackedFiles(root: string): Promise<TrackedPaths> {
  if (existsSync(join(root, '.git'))) {
    const proc = Bun.spawn(['git', '-C', root, 'ls-files', '-z'], {
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: GIT_WALL_MS,
    })
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    if (code !== 0) throw new Error(`git ls-files failed (exit ${code})`)
    return new TrackedPaths(out.split('\0').filter(Boolean))
  }
  const files: string[] = []
  const walk = async (relative: string) => {
    for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) await walk(path)
      } else if (entry.isFile()) files.push(path)
    }
  }
  await walk('')
  return new TrackedPaths(files)
}
