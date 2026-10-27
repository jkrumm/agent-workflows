import { describe, expect, test } from 'bun:test'
import type { RunPreArgs, StepUsage } from '@agent-workflows/runtime'
import { diag } from '@opentelemetry/api'
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace'
import { redactForSpan, Telemetry } from '../src/index.ts'
import { captureLogger } from './support.ts'

const usage: StepUsage = {
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
  cost: null,
  toolCalls: 0,
  unpricedCalls: 0,
  byModel: {},
}

function run(runId: string): RunPreArgs {
  return {
    runId,
    workflowId: 't.wf',
    version: 'v1',
    purpose: 'build',
    parentId: null,
    rootId: runId,
    input: {},
    traceparent: null,
    resume: false,
  }
}

function telemetry() {
  const spans = new InMemorySpanExporter()
  const logger = captureLogger()
  const t = new Telemetry({ logger, exporter: spans, scheduledDelayMillis: 10 })
  return { t, mw: t.middleware(), spans, logger }
}

const step = (runId: string, stepId: string) => ({
  runId,
  workflowId: 't.wf',
  version: 'v1',
  stepId,
  kind: 'agent' as const,
  attempt: 1,
  startedAt: new Date(),
})

describe('telemetry', () => {
  test('steps the runtime ended without stepPost end with their run: cancelled or error, never suspended', async () => {
    const { t, mw, spans } = telemetry()
    for (const [id, status] of [
      ['r-cancel', 'cancelled'],
      ['r-fail', 'failed'],
    ] as const) {
      await mw.runPre?.(run(id))
      await mw.stepPre?.({ ...step(id, 'ask'), status: 'running', replay: false })
      const { resume: _, ...info } = run(id)
      await mw.runPost?.({ ...info, status, output: null, error: null, startedAt: new Date(), finishedAt: new Date() })
    }
    await t.flush()
    const asks = spans.getFinishedSpans().filter((s) => s.name === 'agw.step ask')
    expect(asks).toHaveLength(2)
    const byRun = Object.fromEntries(asks.map((s) => [s.attributes['agw.run.id'], s]))
    expect(byRun['r-cancel']?.attributes['agw.step.status']).toBe('cancelled')
    expect(byRun['r-fail']?.attributes['agw.step.status']).toBe('error')
    expect(byRun['r-fail']?.status.code).toBe(2)
    expect(asks.every((s) => s.attributes['agw.suspended'] === undefined)).toBe(true)
    // Nothing left open: a shutdown suspends no step.
    await t.shutdown()
    expect(spans.getFinishedSpans().some((s) => s.attributes['agw.suspended'])).toBe(false)
  })

  test('opencode.session.id comes from the step handle; error text is redacted and capped', async () => {
    const { t, mw, spans } = telemetry()
    await mw.runPre?.(run('r1'))
    await mw.stepPre?.({ ...step('r1', 'ask'), status: 'running', replay: false })
    await mw.toolPre?.({ runId: 'r1', stepId: 'ask', callId: 'c1', tool: 'curl', error: 'auth Bearer abc.def-123' })
    await mw.stepPost?.({
      ...step('r1', 'ask'),
      status: 'failed',
      finishedAt: new Date(),
      usage,
      handle: { sessionId: 'ses_42' },
      output: null,
      error: { kind: 'error', message: `call failed: key=supersecret sk-abcdef123456 ${'x'.repeat(1000)}` },
    })
    await t.flush()
    const ask = spans.getFinishedSpans().find((s) => s.name === 'agw.step ask')
    expect(ask?.attributes['opencode.session.id']).toBe('ses_42')
    const message = String(ask?.attributes['agw.error.message'])
    expect(message).toStartWith('call failed: key=[redacted] sk-[redacted] ')
    expect(message.length).toBeLessThanOrEqual(501)
    expect(String(ask?.events[0]?.attributes?.['agw.tool.error'])).toBe('auth Bearer [redacted]')
    await t.shutdown()
  })

  test('redactForSpan', () => {
    expect(redactForSpan('Authorization: Bearer eyJhbGciOi.x_y')).toBe('Authorization: Bearer [redacted]')
    expect(redactForSpan('https://x.example.com/?api_key=abc&token=def&q=1')).toBe(
      'https://x.example.com/?api_key=[redacted]&token=[redacted]&q=1',
    )
    expect(redactForSpan('plain failure')).toBe('plain failure')
  })

  test('OTel diagnostics go to the live instance, never a stale first one', async () => {
    const first = telemetry()
    diag.warn('to first')
    await first.t.shutdown()
    const second = telemetry()
    diag.warn('to second')
    expect(first.logger.lines.map((l) => l.message)).toEqual(['telemetry: to first'])
    expect(second.logger.lines.map((l) => l.message)).toEqual(['telemetry: to second'])
    await second.t.shutdown()
    diag.warn('to nobody')
    expect(second.logger.lines).toHaveLength(1)
  })
})
