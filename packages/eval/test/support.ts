import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function git(cwd: string, ...args: string[]): string {
  const ran = Bun.spawnSync(['git', '-c', 'user.email=eval@example.com', '-c', 'user.name=eval', ...args], { cwd })
  if (ran.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${ran.stderr.toString()}`)
  return ran.stdout.toString().trim()
}

/** A home root with `SourceRoot/fixture`: one commit, and a diff on it that applies cleanly. */
export function fixtureHome() {
  const home = mkdtempSync(join(tmpdir(), 'agw-eval-home-'))
  const repo = join(home, 'SourceRoot', 'fixture')
  mkdirSync(repo, { recursive: true })
  git(repo, 'init', '--quiet', '--initial-branch=main')
  writeFileSync(join(repo, 'app.ts'), 'export const a = 1\nexport const b = 2\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '--quiet', '-m', 'init')
  const baseSha = git(repo, 'rev-parse', 'HEAD')
  writeFileSync(join(repo, 'app.ts'), 'export const a = 1\nexport const b = 3\n')
  const diff = `${git(repo, 'diff')}\n`
  git(repo, 'checkout', '--quiet', '--', '.')
  return { home, repo, baseSha, diff }
}

export const BAD_DIFF =
  'diff --git a/app.ts b/app.ts\n--- a/app.ts\n+++ b/app.ts\n@@ -1,2 +1,2 @@\n-nothing like this\n+here\n'
