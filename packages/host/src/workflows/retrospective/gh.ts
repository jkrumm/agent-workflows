export interface IssueRef {
  number: number
  url: string
}

/** The two things the retrospective asks GitHub: does an issue with this title exist, and make one. */
export interface GhPort {
  findByTitle(title: string): Promise<IssueRef | null>
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

/** `gh` against one repository (`owner/name` from host config). Authentication is the host's environment (`GH_TOKEN`). */
export function ghCli(options: { repo: string; run?: Run }): GhPort {
  if (!/^[\w.-]+\/[\w.-]+$/.test(options.repo)) throw new Error('the issue repository must look like owner/name')
  const run = options.run ?? spawnGh
  const call = async (argv: string[]) => {
    const result = await run(argv)
    if (result.exitCode !== 0)
      throw new Error(`gh ${argv[0]} ${argv[1]} failed (exit ${result.exitCode}): ${result.stderr.trim()}`)
    return result.stdout
  }
  return {
    async findByTitle(title) {
      // The search is fuzzy; an exact (case-insensitive) title match decides. Open and closed both count.
      const out = await call([
        'issue',
        'list',
        '--repo',
        options.repo,
        '--state',
        'all',
        '--search',
        `${JSON.stringify(title)} in:title`,
        '--json',
        'number,title,url',
        '--limit',
        '50',
      ])
      const issues = JSON.parse(out) as { number: number; title: string; url: string }[]
      const hit = issues.find((i) => i.title.trim().toLowerCase() === title.trim().toLowerCase())
      return hit ? { number: hit.number, url: hit.url } : null
    },
    async create({ title, body }) {
      const url = (await call(['issue', 'create', '--repo', options.repo, '--title', title, '--body', body])).trim()
      const number = Number(url.split('/').pop())
      return { number: Number.isInteger(number) ? number : 0, url }
    },
  }
}
