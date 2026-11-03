// Real git repos in tmp dirs and a fake reviewer agent for the review v4 tests.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const ID = ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false']

export function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(['git', ...ID, ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`)
  return r.stdout.toString().trim()
}

export function write(root: string, path: string, content: string): void {
  const file = join(root, path)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
}

/** A repo with one commit of `files`; REVIEW.md among them when given. */
export function makeRepo(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agw-rv4-')))
  git(root, 'init', '-q', '-b', 'master')
  for (const [path, content] of Object.entries(files)) write(root, path, content)
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'base')
  return root
}

export function commit(root: string, files: Record<string, string>, message = 'change'): string {
  for (const [path, content] of Object.entries(files)) write(root, path, content)
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', message)
  return git(root, 'rev-parse', 'HEAD')
}

export const lines = (n: number, prefix = 'line') =>
  `${Array.from({ length: n }, (_, i) => `export const ${prefix}${i} = ${i}`).join('\n')}\n`

export type PlantedFinding = {
  tag: 'important' | 'nit' | 'pre-existing'
  class?: string
  file: string
  line?: number
  message: string
  id?: string
  stillOpen?: boolean
}

/**
 * The reviewer agent's reply built from its job dir: the files it echoes come from stat.txt (as the real agent's do),
 * the findings are planted. Wrapped in a json fence with prose around it, as agents tend to answer.
 */
export function fakeReviewer(
  jobDir: string,
  findings: PlantedFinding[] = [],
  extra: { files?: string[]; stepBack?: string | null; summary?: string } = {},
): string {
  const job = JSON.parse(readFileSync(join(jobDir, 'job.json'), 'utf8'))
  const stat = readFileSync(job.files.stat, 'utf8')
  const files =
    extra.files ??
    stat
      .split('\n')
      .filter(Boolean)
      .map((l) => l.split('\t').slice(2).join('\t'))
  const reply = {
    tier: 'deep',
    round: job.round,
    intent: 'does what was asked',
    summary: extra.summary ?? 'LGTM',
    files,
    findings: findings.map((f) => ({
      class: 'bug',
      line: 1,
      failureScenario: 'input x -> wrong y',
      fix: 'fix it',
      ...f,
    })),
    checked: ['value: written at a.ts:1'],
    stepBack: extra.stepBack ?? null,
    unknownField: 'dropped',
  }
  return `Here is my review.\n\n\`\`\`json\n${JSON.stringify(reply, null, 1)}\n\`\`\`\n`
}
