// The gateway's entry; production runs it as one bundled file (`bun build … --target=bun`), so nothing here may read a
// file relative to the source tree or import a workspace path at runtime.
import { mkdirSync } from 'node:fs'
import { ConfigError, type GatewayConfig, loadConfig } from './config.ts'
import { Ledger } from './ledger.ts'
import { errorMessage, stderrLogger as logger } from './log.ts'
import { Outbox, pgUsageSink } from './outbox.ts'
import { createPools } from './pools/index.ts'
import { createProxy } from './proxy.ts'
import { Reconciler } from './reconcile.ts'
import { resolveKeys, secretsRunReader } from './secrets.ts'
import { startGateway } from './server.ts'
import { createTelemetry } from './telemetry.ts'

const EX_CONFIG = 78
const ANTHROPIC_BASE = 'https://api.anthropic.com'
/** The first reconcile of all pools holds the start this long, then the gateway listens anyway. */
const FIRST_RECONCILE_MS = 30_000
/** Above everything `shutdown` waits for; the plist's ExitTimeOut is 90 s. */
const HARD_EXIT_MS = 59_000

function refuse(problems: string[]): never {
  for (const problem of problems) process.stderr.write(`agw-gateway: ${problem}\n`)
  process.exit(EX_CONFIG)
}

function readConfig(): GatewayConfig {
  try {
    return loadConfig(process.env)
  } catch (error) {
    if (error instanceof ConfigError) refuse(error.problems)
    throw error
  }
}

function openLedger(config: GatewayConfig): Ledger {
  try {
    mkdirSync(config.stateDir, { recursive: true })
    return new Ledger(config.ledgerPath)
  } catch (error) {
    refuse([`ledger ${config.ledgerPath} cannot be opened: ${errorMessage(error)}`])
  }
}

const config = readConfig()
const ledger = openLedger(config)
const { keys, adminKeys } = await resolveKeys({ registry: config.registry, read: secretsRunReader(), logger })
const pools = createPools({ registry: config.registry, keys, meter: ledger })
const telemetry = createTelemetry({ env: process.env, logger })

const reconciler = new Reconciler({
  registry: config.registry.filter((pool) => pool.enabled),
  adminKeys,
  pools,
  ledger,
  logger,
  baseUrl: ANTHROPIC_BASE,
})
await Promise.race([reconciler.boot(), Bun.sleep(FIRST_RECONCILE_MS)])
reconciler.start()

const requeuedAtStart = ledger.requeueQuarantined()
if (requeuedAtStart > 0) logger.info('quarantined rows requeued', { rows: requeuedAtStart })

const outbox =
  config.usagePgUrl === null
    ? null
    : new Outbox({ ledger, sink: pgUsageSink({ connectionString: config.usagePgUrl, logger }), logger })
if (outbox === null) logger.warn('USAGE_PG_URL unset: the flush loop is off, rows stay in the ledger')

const proxy = createProxy({
  pools,
  poolKeys: keys,
  ledger,
  outbox,
  telemetry,
  logger,
  doorTokens: config.doorTokens,
  apiSecret: config.apiSecret,
  iu: config.iu,
  anthropicBase: ANTHROPIC_BASE,
  machine: config.machine,
})
outbox?.start()

const server = startGateway({
  port: config.port,
  proxy,
  pools,
  ledger,
  outbox,
  reconciler,
  telemetry,
  logger,
  version: config.version,
  build: config.build,
  requeuedAtStart,
})
logger.info('listening', { port: server.port, version: config.version, build: config.build })

let stopping = false
const stop = (signal: string): void => {
  if (stopping) return
  stopping = true
  logger.info('stopping', { signal })
  setTimeout(() => process.exit(0), HARD_EXIT_MS).unref()
  void server
    .shutdown()
    .catch((error: unknown) => logger.error('shutdown failed', { error: errorMessage(error) }))
    .finally(() => process.exit(0))
}
process.on('SIGTERM', () => stop('SIGTERM'))
process.on('SIGINT', () => stop('SIGINT'))
