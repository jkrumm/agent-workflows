import { DEFAULT_PORT } from './config.js'

export const COMMANDS = ['serve', 'enqueue']
const USAGE = 'usage: example-queue <serve|enqueue> [--port N] [--verbose] [--drain]'

export function parseArgs(argv) {
  const options = { command: argv[0], port: DEFAULT_PORT, verbose: false, drain: false }
  if (!COMMANDS.includes(options.command)) throw new Error(USAGE)
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--port') options.port = Number(argv[++i])
    else if (arg === '--verbose') options.verbose = true
    else if (arg === '--drain') options.drain = true
    else throw new Error(`unknown flag ${arg}\n${USAGE}`)
  }
  return options
}
