import { describe, expect, test } from 'bun:test'
import { createCapabilities, createRegistry } from '@agent-workflows/capabilities'
import { rejection } from './support.ts'
import { fakeTransports } from '@agent-workflows/testing/transports'
import { loadConfig } from '../src/config.ts'
import { factorySignals, SIGNAL_REPO, SIGNAL_SOURCE } from '../src/workflows/retrospective/signals.ts'
import { ToolGate } from '../src/tool-gate/index.ts'
import { agentNames, createWorkflows, fingerprintWorkflows } from '../src/workflows/index.ts'

const base = { AGW_API_SECRET: 'x'.repeat(40), AGW_MACHINE: 'm', AGW_PG_URL: 'postgres://u@h/d' }

describe('retrospective config', () => {
  test('the weekly schedule and its signals are on unless told otherwise', () => {
    expect(loadConfig(base)).toMatchObject({ retroWeekly: true, retroSignals: true })
    for (const off of ['0', 'off', 'false'])
      expect(loadConfig({ ...base, AGW_RETRO_WEEKLY: off }).retroWeekly).toBe(false)
    for (const off of ['0', 'off', 'false'])
      expect(loadConfig({ ...base, AGW_RETRO_SIGNALS: off }).retroSignals).toBe(false)
  })
})

describe('registration', () => {
  const registry = createRegistry(createCapabilities({ transports: fakeTransports({}), env: {} }))
  // Never opened: a gate touches nothing on disk until a workflow grants a step.
  const toolGate = new ToolGate({ stateDir: '/nonexistent/agw-retro-wiring', call: async () => null })
  const stub = {
    journal: { sample: async () => [], countFinished: async () => 0, weekRuns: async () => [] },
    learnings: {} as never,
  }

  test('without the retro deps the host serves what it did before', async () => {
    const ids = (await createWorkflows({ registry, toolGate })).map((w) => w.workflow.id)
    expect(ids).not.toContain('retrospective')
    expect(ids.some((id) => id.startsWith('learnings.'))).toBe(false)
  })

  test('with them: the learnings commands and the retrospective, which runs the retrospective agent on its own route', async () => {
    const entries = await createWorkflows({ registry, toolGate, retro: stub })
    const ids = entries.map((w) => w.workflow.id)
    expect(ids).toEqual(
      expect.arrayContaining([
        'retrospective',
        'learnings.list',
        'learnings.add',
        'learnings.activate',
        'learnings.retire',
      ]),
    )
    expect(fingerprintWorkflows(entries).retrospective).toEqual([{ agent: 'retrospective', route: 'retro.analyze' }])
  })

  test('the retrospective is told each agent once per workflow', async () => {
    for (const agents of agentNames(await createWorkflows({ registry, toolGate })).values()) {
      expect(new Set(agents).size).toBe(agents.length)
    }
  })
})

describe('factorySignals', () => {
  test('files with the factory CLI, title and text as plain arguments, from the agent and for this repo', async () => {
    const calls: { cmd: string[]; timeoutMs?: number }[] = []
    const port = factorySignals({
      bin: '/bin/factory',
      run: async (cmd, options) => {
        calls.push({ cmd, timeoutMs: options?.timeoutMs })
        return { stdout: '', stderr: '', exitCode: 0, timedOut: false }
      },
    })
    await port.file({ title: 't; rm -rf', text: 'line one\nline two' })
    expect(calls[0]?.cmd).toEqual([
      '/bin/factory',
      'signal',
      'file',
      '--from',
      SIGNAL_SOURCE,
      '--repo',
      SIGNAL_REPO,
      '--title',
      't; rm -rf',
      '--text',
      'line one\nline two',
    ])
    expect(SIGNAL_SOURCE).toBe('agent:agent-workflows')
    expect(SIGNAL_REPO).toBe('agent-workflows')
  })

  test('a refusal, a timeout and a CLI that never ran each throw with their reason', async () => {
    const failing = (result: { exitCode: number | null; stderr?: string; timedOut?: boolean; error?: string }) =>
      factorySignals({
        bin: 'factory',
        run: async () => ({ stdout: '', stderr: result.stderr ?? '', timedOut: false, ...result }),
      }).file({ title: 't', text: 'x' })
    expect(await rejection(failing({ exitCode: 2, stderr: 'unknown repo\n' }))).toContain('exit 2: unknown repo')
    expect(await rejection(failing({ exitCode: null, timedOut: true }))).toContain('timed out')
    expect(await rejection(failing({ exitCode: null, error: 'spawn ENOENT' }))).toContain('spawn ENOENT')
  })
})
