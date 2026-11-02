import type { CodeLine, Exec } from '@agent-workflows/eval'

const GIT_TIMEOUT_MS = 30_000
const MAX_CODE_LINES = 160
const MAX_DIFF_LINES = 300

/** `n` lines around `[start, end]` out of a file's text, the claimed lines marked; capped so a huge claim stays readable. */
export function windowOf(text: string, start: number, end: number, radius: number): CodeLine[] | string {
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  if (start > lines.length) return `(the file has ${lines.length} lines, the claim starts at ${start})`
  const from = Math.max(1, start - radius)
  const to = Math.min(lines.length, end + radius)
  const out: CodeLine[] = []
  for (let n = from; n <= to && out.length < MAX_CODE_LINES; n++) {
    out.push({ n, text: lines[n - 1] as string, mark: n >= start && n <= end })
  }
  return out
}

export function cutDiff(text: string): string {
  const lines = text.split('\n')
  return lines.length <= MAX_DIFF_LINES
    ? text
    : `${lines.slice(0, MAX_DIFF_LINES).join('\n')}\n… (cut at ${MAX_DIFF_LINES} lines)`
}

/** The reads of one repo checkout the pack needs, as text; a failure comes back as a sentence, never a throw. */
export function gitReader(exec: Exec, dir: string) {
  const git = (args: string[]) => exec('git', ['-C', dir, ...args], { timeoutMs: GIT_TIMEOUT_MS })
  return {
    /** `file` as `sha` left it, around `[start, end]`. */
    async postImage(input: {
      sha: string
      file: string
      start: number
      end: number
      radius: number
    }): Promise<CodeLine[] | string> {
      const shown = await git(['show', `${input.sha}:${input.file}`])
      if (shown.code !== 0)
        return `(code unavailable: ${shown.stderr.trim().split('\n')[0] || `git exited ${shown.code}`})`
      return windowOf(shown.stdout, input.start, input.end, input.radius)
    },
    /** The fix commit's diff for `file`, else the whole commit when it did not touch that path. */
    async fixDiff(sha: string, file: string): Promise<string> {
      const one = await git(['show', '--format=', sha, '--', file])
      if (one.code === 0 && one.stdout.trim()) return cutDiff(one.stdout)
      const all = await git(['show', '--format=', sha])
      if (all.code !== 0) return `(diff unavailable: ${all.stderr.trim().split('\n')[0] || `git exited ${all.code}`})`
      return cutDiff(all.stdout)
    },
  }
}
