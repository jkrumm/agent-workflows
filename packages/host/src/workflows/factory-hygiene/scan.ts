import { readdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'

const SKIPPED = new Set(['.git', 'node_modules'])
/** A checkout with more entries than this is not scanned to the end, and a tree that cannot be vouched for is not read. */
const MAX_ENTRIES = 200_000

/**
 * The first symlink below `root` whose target leaves it, as a path relative to `root`; `null` when none does. The agent's
 * grant is matched against the path it names, not where a link leads (packages/opencode-host/README.md §Symlinks inside an
 * allowed directory), so a checkout with such a link is not handed to it. `.git` and `node_modules` are not entered.
 * Throws when the tree has more than {@link MAX_ENTRIES} entries: the caller fails closed.
 */
export async function findEscapingLink(root: string): Promise<string | null> {
  const base = await realpath(root)
  let seen = 0
  const todo = [base]
  for (let dir = todo.pop(); dir !== undefined; dir = todo.pop()) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (++seen > MAX_ENTRIES) throw new Error(`more than ${MAX_ENTRIES} entries`)
      const path = join(dir, entry.name)
      if (entry.isSymbolicLink()) {
        const target = await realpath(path).catch(() => null)
        // A dangling link reads nothing.
        if (target === null) continue
        const inside = relative(base, target)
        if (inside.startsWith('..') || isAbsolute(inside)) return relative(base, path)
      } else if (entry.isDirectory() && !SKIPPED.has(entry.name)) {
        todo.push(path)
      }
    }
  }
  return null
}
