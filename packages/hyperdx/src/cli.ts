import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply, exportDefinitions, type Hdx, loadDefinitions } from './sync.ts'

const DEFINITIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'definitions')
/** The dashboard's name, and the tag every one of its alerts carries. */
const DASHBOARD = 'agw'
const TAG = 'agw'

const USAGE = `usage: bun packages/hyperdx/src/cli.ts apply|export [--env prod|local] [--dry-run]

  apply    upsert the dashboard "${DASHBOARD}" and its alerts (by name) from packages/hyperdx/definitions
  export   write the live dashboard and its "${TAG}"-tagged alerts back into definitions/ (capture a UI edit)
  --dry-run  with apply: validate the dashboard and print the plan, write nothing`

/** The `agw hdx` door: a read is `hdx rest`, a write `hdx write --commit`; the door holds the credentials, this holds none. */
function agwHdx(env: string): Hdx {
  async function run(args: string[]): Promise<unknown> {
    const proc = Bun.spawn(['agw', 'hdx', ...args, '--env', env, '--format', 'plain', '--max-chars', '500000'], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    if (code !== 0) throw new Error(`agw hdx ${args.slice(0, 3).join(' ')} exited ${code}: ${stdout}${stderr}`)
    return JSON.parse(stdout)
  }
  return {
    get: (path) => run(['rest', path]),
    send: (method, path, body) =>
      run(['write', '--method', method, '--path', path, '--body', JSON.stringify(body), '--commit']),
  }
}

async function main(argv: string[]): Promise<void> {
  const command = argv[0]
  const envFlag = argv.indexOf('--env')
  const env = envFlag === -1 ? 'prod' : (argv[envFlag + 1] ?? 'prod')
  if (command !== 'apply' && command !== 'export') {
    console.error(USAGE)
    process.exit(2)
  }
  const hdx = agwHdx(env)
  if (command === 'export') {
    for (const file of await exportDefinitions(hdx, DEFINITIONS, DASHBOARD, TAG)) console.log(`wrote ${file}`)
    return
  }
  const lines = await apply(hdx, await loadDefinitions(DEFINITIONS), { dryRun: argv.includes('--dry-run') })
  for (const line of lines) console.log(line)
}

await main(process.argv.slice(2))
