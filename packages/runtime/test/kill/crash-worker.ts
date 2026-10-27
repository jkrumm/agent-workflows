// A worker whose step takes the process down on every boot: the persisted drive cap must end the run.
import { z } from 'zod'
import { defineWorkflow, Runtime } from '../../src/index.ts'
import { testPgUrl } from '../support/pg.ts'

export const poison = defineWorkflow({
  id: 'kill.poison',
  version: 'v1',
  input: z.object({}),
  output: z.object({}),
  async run(ctx) {
    await ctx.step('explode', () => {
      process.kill(process.pid, 'SIGKILL')
      return null
    })
    return {}
  },
})

if (import.meta.main) {
  const runtime = new Runtime({
    connectionString: testPgUrl(),
    schema: process.env.KILL_SCHEMA ?? '',
    workflows: [poison],
    maxDrives: Number(process.env.MAX_DRIVES ?? 3),
    journalPoolSize: 2,
    maxConcurrentRuns: 2,
    recoveryIntervalMs: 50,
  })
  await runtime.open()
}
