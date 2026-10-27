// One worker process of the kill harness. It drives every run in its schema and may kill itself at KILL_AT.
import { Pool } from 'pg'
import { Runtime } from '../../src/index.ts'
import { testPgUrl } from '../support/pg.ts'
import { killWorkflows } from './workflows.ts'
import { parseKillAt, World } from './world.ts'

const env = process.env
const schema = env.KILL_SCHEMA ?? ''
const version = env.WF_VERSION ?? 'v1'
const url = testPgUrl()
const pool = new Pool({ connectionString: url, max: 3 })
const world = new World(pool, schema, version, parseKillAt(env.KILL_AT), Number(env.AGENT_MS ?? 1200))
const { main } = killWorkflows(world, {
  version,
  withAudit: env.WF_AUDIT === '1',
  effectWindowMs: Number(env.EFFECT_WINDOW_MS ?? 300),
  childMs: Number(env.CHILD_MS ?? 200),
})

const runtime = new Runtime({
  connectionString: url,
  schema,
  workflows: [main],
  host: world.host(),
  middleware: [world.ledgerMiddleware()],
  maxConcurrentRuns: Number(env.MAX_RUNS ?? 4),
  journalPoolSize: Number(env.JOURNAL_POOL ?? 2),
  recoveryIntervalMs: 100,
  watchIntervalMs: 100,
  infraBackoffMs: 100,
  // A killed effect is resumed only after this grace (from its last start); short for the harness.
  bodyGraceMs: 500,
})

process.on('SIGTERM', () => {
  void runtime
    .close()
    .then(() => pool.end())
    .finally(() => process.exit(0))
})

await runtime.open()
