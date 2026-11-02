import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Json, Usage } from '@agent-workflows/runtime'
import { createClient, type OpenCodeHandle, OpenCodeHost, OpenCodeServer } from '../src/index.ts'
import { attributionOf } from './attribution.ts'

// The real `opencode` 2.0.32 on `check` (Haiku), one JSON step and a follow-up turn, about $0.002. Run with:
//   AGW_LIVE=1 secrets-run run --env-file=.env.tpl -- timeout 600 bun test packages/opencode-host/test/live-structured.test.ts
// The step's schema is what `z.toJSONSchema(…, { io: 'input' })` gives for a review-angle-like shape (`$schema`, an
// enum, a nullable field as `anyOf`, an array of objects, an optional key). The model is told to make one invalid call
// first: OpenCode must reject it against the schema, and the step's output must be the later valid call's input.
const live = process.env.AGW_LIVE === '1'
const name = 'live: a JSON step returns a schema-valid object through submit_result, and so does its follow-up turn'

const SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          title: { type: 'string' },
          line: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] },
          note: { type: 'string' },
        },
        required: ['severity', 'title', 'line'],
      },
    },
  },
  required: ['findings'],
} as const satisfies Json

/** The schema's rules, checked by hand: the test must not trust the tool's own validation. */
function schemaValid(value: Json): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const findings = (value as Record<string, Json>).findings
  return (
    Array.isArray(findings) &&
    findings.every((f) => {
      if (f === null || typeof f !== 'object' || Array.isArray(f)) return false
      const { severity, title, line, note } = f as Record<string, Json>
      return (
        ['high', 'medium', 'low'].includes(severity as string) &&
        typeof title === 'string' &&
        (line === null || (typeof line === 'number' && Number.isInteger(line) && line >= 1)) &&
        (note === undefined || typeof note === 'string')
      )
    })
  )
}

test.skipIf(!live)(
  live ? name : `${name} (skipped: runs only with AGW_LIVE=1)`,
  async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'och-live-'))
    const server = new OpenCodeServer({ stateDir, livenessIntervalMs: 1_000 })
    const host = new OpenCodeHost({
      server,
      stateDir,
      agents: [
        { name: 'live-json', route: 'check', agentsMd: '# Rules\n\nDo not call any tool except submit_result.\n' },
      ],
    })
    const wait = { signal: AbortSignal.timeout(300_000), onProgress: () => {}, onTool: async () => {} } // test bound only
    try {
      await server.start()
      const client = createClient(() => server.endpoint())
      const handle = (await host.open({
        runId: 'live',
        stepId: 'json',
        attribution: attributionOf('live', 'json'),
        key: 'live:json',
        agent: 'live-json',
        prompt: '',
        options: { output: 'json' },
        schema: SCHEMA,
      })) as OpenCodeHandle
      await host.prompt(
        handle,
        'Review this line of code: `const total = items.reduce((a, b) => a + b)`. This is a test of the result tool: ' +
          'first call submit_result with exactly {"findings": [{"severity": "critical", "title": "x", "line": 0}]} ' +
          '(invalid on purpose). After it is rejected, call it again with one or two real findings about the line.',
      )
      const first = await host.wait(handle, wait)

      const next = await host.followUp(handle, {
        runId: 'live',
        stepId: 'again',
        key: 'live:again',
        attempt: 1,
        attribution: attributionOf('live', 'again'),
      })
      await host.prompt(next, 'Now submit an empty findings list through submit_result.')
      const second = await host.wait(next, wait)

      const messages = await client.messages(handle.sessionId)
      const calls = messages.flatMap((m) =>
        (m.content ?? [])
          .filter((p) => p.type === 'tool' && p.name === 'submit_result')
          .map((p) => ({
            status: p.state?.status,
            input: p.state?.input,
            error: typeof p.state?.error === 'object' ? p.state.error?.message?.split('\n')[0] : p.state?.error,
          })),
      )
      const usage = first.usage as Usage
      console.log(
        `live structured output ${JSON.stringify({ calls, first: first.output, second: second.output, usage }, null, 2)}`,
      )

      expect(calls[0]?.status).toBe('error') // the planted invalid call, rejected by OpenCode against the schema
      expect(calls.filter((c) => c.status === 'completed').length).toBeGreaterThanOrEqual(2)
      expect(schemaValid(first.output)).toBe(true)
      expect((first.output as { findings: unknown[] }).findings.length).toBeGreaterThan(0)
      expect(second.output).toEqual({ findings: [] })
      expect(usage.cost ?? 1).toBeLessThan(0.05)
    } finally {
      host.close()
      await server.close({ stop: true })
      rmSync(stateDir, { recursive: true, force: true })
    }
  },
  600_000,
)
