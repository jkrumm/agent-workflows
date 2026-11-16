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

/** The command and its flags, strictly: a misspelled `--dry-run` must stop, never run as a live apply. */
function parseArgs(argv: string[]): { command: 'apply' | 'export'; env: string; dryRun: boolean } {
  const [command, ...rest] = argv
  if (command !== 'apply' && command !== 'export') throw new Error(`unknown command ${command ?? '(none)'}`)
  let env = 'prod'
  let dryRun = false
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i]
    if (flag === '--env' && rest[i + 1] !== undefined) {
      env = rest[i + 1] ?? env
      i += 1
    } else if (flag === '--dry-run' && command === 'apply') dryRun = true
    else throw new Error(`unknown argument ${flag ?? ''}`)
  }
  return { command, env, dryRun }
}

async function main(argv: string[]): Promise<void> {
  let args: ReturnType<typeof parseArgs>
  try {
    args = parseArgs(argv)
  } catch (error) {
    console.error(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`)
    process.exit(2)
  }
  const hdx = agwHdx(args.env)
  if (args.command === 'export') {
    for (const file of await exportDefinitions(hdx, DEFINITIONS, DASHBOARD, TAG)) console.log(`wrote ${file}`)
    return
  }
  const lines = await apply(hdx, await loadDefinitions(DEFINITIONS), { dryRun: args.dryRun })
  for (const line of lines) console.log(line)
}

await main(process.argv.slice(2))
