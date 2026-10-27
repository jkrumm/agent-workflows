// A process that owns telemetry the way a host does: exporter configured only by the OTEL_* env, flush handlers
// installed, a run and a step span ended and waiting in the batch (the 60 s delay means only a flush delivers).
// Mode (argv[2]): `signal` waits for SIGTERM/SIGINT, `crash` throws, `drop` overflows the queue first.
import type { StepUsage } from '@agent-workflows/runtime'
import { Telemetry } from '../../src/index.ts'

const mode = process.argv[2] ?? 'signal'
const telemetry = new Telemetry({
  logger: {
    warn: (message, meta) => console.error(`WARN ${message} ${JSON.stringify(meta ?? {})}`),
    error: (message, meta) => console.error(`ERROR ${message} ${JSON.stringify(meta ?? {})}`),
  },
  serviceName: 'agw-flush-test',
  scheduledDelayMillis: 60_000,
  maxQueueSize: mode === 'drop' ? 2 : 2048,
  flushTimeoutMs: 3000,
})
telemetry.installFlush({
  onSignal: async (signal) => {
    console.error(`onSignal ${signal}`)
  },
})

const mw = telemetry.middleware()
const usage: StepUsage = {
  tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
  cost: null,
  toolCalls: 0,
  unpricedCalls: 0,
  byModel: {},
}
const runs = mode === 'drop' ? 5 : 1
for (let i = 0; i < runs; i++) {
  const run = {
    runId: `run_${i}`,
    workflowId: 'flush.test',
    version: 'v1',
    purpose: 'build',
    parentId: null,
    rootId: `run_${i}`,
    input: {},
    traceparent: null,
  }
  await mw.runPre?.({ ...run, resume: false })
  const step = {
    runId: run.runId,
    workflowId: 'flush.test',
    version: 'v1',
    stepId: 'one',
    kind: 'code' as const,
    attempt: 1,
    startedAt: new Date(),
  }
  await mw.stepPre?.({ ...step, status: 'running', replay: false })
  await mw.stepPost?.({ ...step, status: 'done', finishedAt: new Date(), usage, handle: null, output: 1, error: null })
  await mw.runPost?.({ ...run, status: 'done', output: {}, error: null, startedAt: new Date(), finishedAt: new Date() })
}

console.log('ready')
setInterval(() => {}, 1000)
if (mode === 'crash') {
  setTimeout(() => {
    void Promise.reject(new Error('boom'))
  }, 50)
}
