import { boot } from './boot.ts'
import { loadConfig } from './config.ts'
import { readDoorTokens } from './door-tokens.ts'
import { installLifecycle } from './lifecycle.ts'

let config: ReturnType<typeof loadConfig>
try {
  config = loadConfig(process.env)
} catch (error) {
  console.error(`[agw-host] ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

// The image door's caller tokens (the file the audio process reads): a missing, wider-mode or malformed file refuses the
// start, naming the file and the line, never a token.
let tokens: ReturnType<typeof readDoorTokens>
try {
  tokens = readDoorTokens(config.doorTokensFile)
} catch (error) {
  console.error(`[agw-host] ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

const running = await boot(config, { door: { tokens } }).catch((error: unknown) => {
  console.error('[agw-host] start failed:', error instanceof Error ? error.message : error)
  process.exit(1)
})
console.log(`[agw-host] listening on 127.0.0.1:${running.port} (${config.version})`)

// Deploys need no drain (concept §3): runs stay `running` and the next process resumes them.
installLifecycle({ shutdown: () => running.shutdown() })
