import { markerFor } from './issue.ts'

export interface IssueRef {
  number: number
  url: string
}

/** The two things the retrospective asks GitHub: is there an issue for this proposal hash, and make one. */
export interface GhPort {
  findByHash(hash: string): Promise<IssueRef | null>
  create(issue: { title: string; body: string }): Promise<IssueRef>
}

type Run = (argv: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>

const GH_WALL_MS = 60_000

const spawnGh: Run = async (argv) => {
  const proc = Bun.spawn(['gh', ...argv], { stdout: 'pipe', stderr: 'pipe', timeout: GH_WALL_MS })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { exitCode, stdout, stderr }
}

type Found = { number: number; url: string; body: string }

/**
 * `gh` against one repository (`owner/name` from host config). Authentication is the host's environment (`GH_TOKEN`).
 * The dedupe is a search for the proposal's marker in issue bodies (open and closed); the result is verified against
 * the issue's own body, so a fuzzy hit never counts. Known window: GitHub's search index lags a new issue by seconds
 * to minutes, so a second run in that window can file a duplicate. The weekly cadence and the retry bound keep that
 * rare; it is not closed by a lock.
 */
export function ghCli(options: { repo: string; run?: Run }): GhPort {
  if (!/^[\w.-]+\/[\w.-]+$/.test(options.repo)) throw new Error('the issue repository must look like owner/name')
  const run = options.run ?? spawnGh
  const call = async (argv: string[]) => {
    const result = await run(argv)
    if (result.exitCode !== 0) {
      throw new Error(`gh ${argv[0]} ${argv[1]} failed (exit ${result.exitCode}): ${result.stderr.trim()}`)
    }
    return result.stdout
  }
  return {
    async findByHash(hash) {
      const out = await call([
        'issue',
        'list',
        '--repo',
        options.repo,
        '--state',
        'all',
        '--search',
        `"agw-retro:${hash}" in:body`,
        '--json',
        'number,url,body',
        '--limit',
        '20',
      ])
      const hit = (JSON.parse(out) as Found[]).find((issue) => issue.body.includes(markerFor(hash)))
      return hit ? { number: hit.number, url: hit.url } : null
    },
    async create({ title, body }) {
      const url = (await call(['issue', 'create', '--repo', options.repo, '--title', title, '--body', body])).trim()
      const number = Number(url.split('/').pop())
      return { number: Number.isInteger(number) ? number : 0, url }
    },
  }
}
