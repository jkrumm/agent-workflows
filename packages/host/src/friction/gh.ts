/** What GitHub says about one issue. `deleted` is only the "no such issue" answer; any other failure throws. */
export type IssueState = { state: 'open' | 'closed' | 'deleted'; closedAt: string | null }

/** The GitHub operations the job needs. A fake in tests; the `gh` CLI in production. */
export type GhPort = {
  /** Whether issue `number` of `repo` is open, closed (and when) or gone. Throws on anything it cannot tell. */
  issueState(repo: string, number: number, signal?: AbortSignal): Promise<IssueState>
  /** Issues of any state in `repo` whose title is exactly `title`, with when each was created. */
  findIssuesByTitle(
    repo: string,
    title: string,
    signal?: AbortSignal,
  ): Promise<{ number: number; url: string; createdAt: string }[]>
  /** Opens an issue; returns its URL. */
  createIssue(repo: string, title: string, body: string, signal?: AbortSignal): Promise<string>
}

const HELPER_TIMEOUT_MS = 60_000

async function gh(args: string[], options: { stdin?: string; signal?: AbortSignal } = {}): Promise<string> {
  const proc = Bun.spawn(['gh', ...args], {
    stdin: options.stdin === undefined ? 'ignore' : new TextEncoder().encode(options.stdin),
    stdout: 'pipe',
    stderr: 'pipe',
    // A helper subprocess, not an agent run: a hang guard is fine here. Shutdown aborts it through the signal.
    timeout: HELPER_TIMEOUT_MS,
    signal: options.signal,
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) throw new Error(`gh ${args.slice(0, 2).join(' ')} exited ${code}: ${err.trim().slice(0, 300)}`)
  return out
}

/** The issue number out of the URL `gh issue create` prints. */
export function issueNumber(url: string): number {
  const match = /\/issues\/(\d+)\s*$/.exec(url.trim())
  if (!match) throw new Error('gh issue create printed no issue URL')
  return Number(match[1])
}

/** The `gh` CLI on PATH, already authenticated. The body goes over stdin, never on the command line. */
export const ghCli: GhPort = {
  async issueState(repo, number, signal) {
    try {
      const out = await gh(['issue', 'view', String(number), '--repo', repo, '--json', 'state,closedAt'], { signal })
      const issue = JSON.parse(out) as { state: string; closedAt?: string | null }
      return issue.state === 'OPEN'
        ? { state: 'open', closedAt: null }
        : { state: 'closed', closedAt: issue.closedAt || null }
    } catch (err) {
      // Only GitHub's own "no such issue" answer means deleted. A missing `gh`, a repository that cannot be reached
      // ("Repository not found", HTTP 404 on access), a network failure: the state is unknown, so this throws and the
      // job skips the workflow this tick.
      if (err instanceof Error && /Could not resolve to an issue/i.test(err.message)) {
        return { state: 'deleted', closedAt: null }
      }
      throw err
    }
  },
  async findIssuesByTitle(repo, title, signal) {
    const out = await gh(
      [
        'issue',
        'list',
        '--repo',
        repo,
        '--state',
        'all',
        '--search',
        `"${title.replaceAll('"', ' ')}" in:title`,
        '--json',
        'number,title,url,createdAt',
        '--limit',
        '30',
      ],
      { signal },
    )
    const issues = JSON.parse(out) as { number: number; title: string; url: string; createdAt: string }[]
    return issues
      .filter((issue) => issue.title === title)
      .map(({ number, url, createdAt }) => ({ number, url, createdAt }))
  },
  async createIssue(repo, title, body, signal) {
    return (
      await gh(['issue', 'create', '--repo', repo, '--title', title, '--body-file', '-'], { stdin: body, signal })
    ).trim()
  },
}
