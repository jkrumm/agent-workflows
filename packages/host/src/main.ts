import { boot } from './boot.ts'
import { loadConfig } from './config.ts'

let config: ReturnType<typeof loadConfig>
try {
  config = loadConfig(process.env)
} catch (error) {
  console.error(`[agw-host] ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

const running = await boot(config).catch((error: unknown) => {
  console.error('[agw-host] start failed:', error instanceof Error ? error.message : error)
  process.exit(1)
})
console.log(`[agw-host] listening on 127.0.0.1:${running.port} (${config.version})`)

// Deploys need no drain (concept §3): runs stay `running` and the next process resumes them.
let signalled = false
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    if (signalled) return
    signalled = true
    console.log(`[agw-host] ${signal}: shutting down`)
    running.shutdown().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error('[agw-host] shutdown failed:', error instanceof Error ? error.message : error)
        process.exit(1)
      },
    )
  })
}
for (const event of ['uncaughtException', 'unhandledRejection'] as const) {
  process.on(event, (error) => {
    console.error(`[agw-host] ${event}:`, error)
    void running.shutdown().finally(() => process.exit(1))
  })
}
