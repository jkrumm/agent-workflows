import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type OpenCodeHandle,
  OpenCodeHost,
  OpenCodeServer,
  resolveOpencodeBinary,
} from '@agent-workflows/opencode-host'
import type { Json } from '@agent-workflows/runtime'
import { loadAgentDefinitions } from '../src/agents.ts'
import { ToolGate } from '../src/tool-gate/index.ts'
import { GATE_TOOLS, RESEARCH_TOOLS, researchGrant } from '../src/workflows/research/tools.ts'
import { memoryToolLedger } from '../src/workflows/research/ledger.ts'

// The research agent on the real `opencode` 2.0.32 against a scripted fake model (no spend): the plugin in their
// location reaches the tool gate with the session id, the gate refuses an ungranted tool, and the route (the HARD tier, Sonnet on the
// Anthropic leg) keeps the wire rules (thinking blocks passed back verbatim, cache reads recorded and priced). Skipped where no opencode is
// installed (CI runners).
let binary: string | null = null
try {
  binary = resolveOpencodeBinary()
} catch {
  binary = null
}

type Step = { tool: string; args: Record<string, unknown> } | { text: string }
type Seen = { tools: string[]; messages: Record<string, unknown>[] }

/**
 * A scripted endpoint on the Anthropic Messages wire (the gateway's `/anthropic/v1/messages`, what Claude routes use): it
 * plays `script` turn by turn and records every request, normalised to the shape the assertions read (`tools` names,
 * and `messages` where a tool result is a `{ role: 'tool', content }` entry). Each turn opens with a thinking block
 * (`REASONING-n`) so the replay of provider reasoning is observable; usage carries 800 cache-read tokens.
 */
function fakeModel(script: Step[]) {
  const seen: Seen[] = []
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const body = (await req.json()) as { tools?: { name: string }[]; messages: Record<string, unknown>[] }
      seen.push({ tools: (body.tools ?? []).map((t) => t.name).sort(), messages: normalise(body.messages) })
      const step = script[Math.min(seen.length - 1, script.length - 1)] as Step
      const event = (type: string, data: unknown) =>
        `event: ${type}\ndata: ${JSON.stringify({ type, ...(data as object) })}\n\n`
      const block = (index: number, start: unknown, ...deltas: unknown[]) =>
        event('content_block_start', { index, content_block: start }) +
        deltas.map((delta) => event('content_block_delta', { index, delta })).join('') +
        event('content_block_stop', { index })
      let out = event('message_start', {
        message: {
          id: `msg_${seen.length}`,
          type: 'message',
          role: 'assistant',
          model: 'claude-fake',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 200, output_tokens: 1, cache_read_input_tokens: 800, cache_creation_input_tokens: 0 },
        },
      })
      out += block(
        0,
        { type: 'thinking', thinking: '' },
        { type: 'thinking_delta', thinking: `REASONING-${seen.length}` },
        { type: 'signature_delta', signature: `sig-${seen.length}` },
      )
      out +=
        'tool' in step
          ? block(
              1,
              { type: 'tool_use', id: `toolu_${seen.length}`, name: step.tool, input: {} },
              { type: 'input_json_delta', partial_json: JSON.stringify(step.args) },
            )
          : block(1, { type: 'text', text: '' }, { type: 'text_delta', text: step.text })
      out += event('message_delta', {
        delta: { stop_reason: 'tool' in step ? 'tool_use' : 'end_turn', stop_sequence: null },
        usage: { output_tokens: 100 },
      })
      out += event('message_stop', {})
      return new Response(out, { headers: { 'content-type': 'text/event-stream' } })
    },
  })
  return { server, seen }
}

/** Messages turns as the assertions read them: a user turn of tool results becomes one `tool` entry per result. */
function normalise(messages: Record<string, unknown>[]): Record<string, unknown>[] {
  return messages.flatMap((m) => {
    if (m.role !== 'user' || !Array.isArray(m.content)) return [m]
    const results = (m.content as { type: string; content?: unknown }[]).filter((b) => b.type === 'tool_result')
    if (results.length === 0) return [m]
    return results.map((b) => ({
      role: 'tool',
      content: Array.isArray(b.content) ? b.content.map((c: { text?: string }) => c.text ?? '').join('') : b.content,
    }))
  })
}

const REPORT = JSON.stringify({
  report: '## Bottom line\nPort 5432.',
  citations: [
    {
      claim: 'PostgreSQL listens on 5432',
      url: 'https://www.postgresql.org/docs/current/runtime-config-connection.html',
      confidence: 'high',
    },
  ],
  sources: ['https://www.postgresql.org/docs/current/runtime-config-connection.html'],
  unverified: [],
})

const stateDir = mkdtempSync(join(tmpdir(), 'agw-research-oc-'))
const calls: { id: string; input: Json }[] = []
const ledger = memoryToolLedger()
const gate = new ToolGate({
  stateDir,
  call: async (id, input, { addUsage }) => {
    calls.push({ id, input })
    addUsage({
      model: 'sonar',
      tokens: { input: 0, output: 0, cacheRead: 0, reasoning: 0 },
      cost: 0.005,
      costSource: 'provider',
    })
    return {
      results: [
        { url: 'https://www.postgresql.org/docs/current/runtime-config-connection.html', title: 't', snippet: 's' },
      ],
      provider: 'sonar',
    }
  },
})

beforeAll(() => {
  gate.ensureServing()
})
afterAll(async () => {
  await gate.close()
  rmSync(stateDir, { recursive: true, force: true })
})

async function runAgent(agent: string, script: Step[], grantTools: string[]) {
  const model = fakeModel(script)
  const env = {
    ...process.env,
    AGW_GATEWAY_TOOL_TOKEN: 'fake',
    AGW_GATEWAY_URL: `http://127.0.0.1:${model.server.port}`,
  }
  const server = new OpenCodeServer({ stateDir, env, livenessIntervalMs: 1_000 })
  const agents = loadAgentDefinitions(join(import.meta.dir, '..', '..', '..', 'agents')).filter((a) => a.name === agent)
  const host = new OpenCodeHost({ server, stateDir, agents })
  const runId = `r${Math.random().toString(36).slice(2)}`
  const key = `${runId}:research`
  const close = gate.open({
    runId,
    stepId: 'research',
    ...researchGrant(ledger),
    tools: Object.fromEntries(grantTools.map((tool) => [tool, RESEARCH_TOOLS[tool as keyof typeof RESEARCH_TOOLS]])),
  })
  try {
    await server.start()
    const handle = (await host.open({
      runId,
      stepId: 'research',
      key,
      agent,
      prompt: '',
      // A text step, as the workflow runs it: its draft is parsed by the workflow, not the host.
      attribution: { runId, rootId: runId, workflow: 'research', step: 'research', purpose: 'verify' },
    })) as OpenCodeHandle
    await host.prompt(handle, 'What is the default port of PostgreSQL?')
    const result = await host.wait(handle, {
      signal: AbortSignal.timeout(90_000),
      onProgress: () => {},
      onTool: async () => {},
    })
    return { result, seen: model.seen, entries: await ledger.read(runId, 'research') }
  } finally {
    await close()
    host.close()
    await server.close({ stop: true })
    void model.server.stop(true)
  }
}

test.skipIf(!binary)(
  'a research agent calls the platform web tools through the gate; the Claude wire rules hold',
  async () => {
    const { result, seen, entries } = await runAgent(
      'research',
      [{ tool: 'web_search', args: { query: 'postgres default port' } }, { text: REPORT }],
      [...GATE_TOOLS],
    )
    // The model is offered exactly the agent's tools (deny by default, then its allow rules): no OpenCode web tools.
    expect(seen[0]?.tools).toEqual([
      'glob',
      'grep',
      'read',
      'skill',
      'web_ask',
      'web_docs',
      'web_fetch',
      'web_package',
      'web_search',
      'web_youtube',
    ])
    expect(calls).toEqual([{ id: 'web.search', input: { query: 'postgres default port' } }])
    expect(entries).toMatchObject([
      {
        tool: 'web_search',
        ok: true,
        retrieved: [],
        seen: ['https://www.postgresql.org/docs/current/runtime-config-connection.html'],
      },
    ])
    // The tool result reached the model as its content.
    const toolMessage = seen[1]?.messages.find((m) => m.role === 'tool')
    expect(String(toolMessage?.content)).toContain('runtime-config-connection')
    // Claude wire rules: the first turn's thinking block goes back verbatim, signature included, with its tool call.
    const assistant = seen[1]?.messages.find((m) => m.role === 'assistant')
    expect(JSON.stringify(assistant)).toContain('REASONING-1')
    expect(JSON.stringify(assistant)).toContain('sig-1')
    // Cache reads are recorded and priced with the route's rate.
    const usage = [result.usage ?? []].flat()[0]
    expect(usage?.tokens.cacheRead).toBe(1_600)
    expect(usage?.cost).toBeGreaterThan(0)
    expect(JSON.parse(result.output as string) as Record<string, unknown>).toMatchObject({
      report: '## Bottom line\nPort 5432.',
    })
    // The gate's key file is the user's only.
    expect(statSync(join(stateDir, 'gate.json')).mode & 0o777).toBe(0o600)
  },
  120_000,
)

test.skipIf(!binary)(
  'the gate refuses a tool the grant does not hold, and the model sees the refusal',
  async () => {
    const { seen, entries } = await runAgent(
      'research',
      [{ tool: 'web_package', args: { registry: 'npm', name: 'hono' } }, { text: REPORT }],
      ['web_search'],
    )
    const toolMessage = seen[1]?.messages.find((m) => m.role === 'tool')
    expect(String(toolMessage?.content)).toContain('ERROR: web_package is not granted')
    expect(entries).toEqual([])
  },
  120_000,
)

test.skipIf(!binary)(
  "the gate's key is out of the session's reach: read is refused outside the location",
  async () => {
    const keyFile = join(stateDir, 'gate.json')
    const { seen } = await runAgent('research', [{ tool: 'read', args: { path: keyFile } }, { text: REPORT }], [])
    const toolMessage = String(seen[1]?.messages.find((m) => m.role === 'tool')?.content)
    const { key } = JSON.parse(await Bun.file(keyFile).text()) as { key: string }
    expect(toolMessage).not.toContain(key)
    expect(toolMessage.toLowerCase()).toMatch(/denied|not allowed|permission|outside|reject/)
  },
  120_000,
)

test("an agent's plugins are written to its location's .opencode/plugins/ and move its hash and the run fingerprint", async () => {
  const { compileLocation } = await import('@agent-workflows/opencode-host')
  const { fsFingerprintSource } = await import('@agent-workflows/middleware')
  const { cpSync, readFileSync, writeFileSync } = await import('node:fs')
  const dir = mkdtempSync(join(tmpdir(), 'agw-plugins-'))
  try {
    const base = { name: 'probe', agentsMd: '# p\n', plugins: { 'agw-tools.ts': 'export default {}\n' } }
    const loc = compileLocation(base, { stateDir: dir })
    expect(readFileSync(join(loc.directory, '.opencode', 'plugins', 'agw-tools.ts'), 'utf8')).toBe(
      'export default {}\n',
    )
    expect(
      compileLocation({ ...base, plugins: { 'agw-tools.ts': 'export default { x: 1 }\n' } }, { stateDir: dir }).hash,
    ).not.toBe(loc.hash)
    expect(() => compileLocation({ ...base, plugins: { '../escape.ts': '' } }, { stateDir: dir })).toThrow(
      'leaves the plugins directory',
    )

    const agentsDir = join(dir, 'agents')
    cpSync(join(import.meta.dir, '..', '..', '..', 'agents', 'research'), join(agentsDir, 'research'), {
      recursive: true,
    })
    const source = fsFingerprintSource({
      agentsDir,
      workflows: { research: [{ agent: 'research', route: 'research.agent' }] },
      opencodeBin: binary ?? '/bin/echo',
    })
    const before = JSON.stringify(await source.inputs({ id: 'research' } as never))
    expect(before).toContain('plugins/agw-tools.ts')
    writeFileSync(join(agentsDir, 'research', 'plugins', 'agw-tools.ts'), '// changed\n')
    expect(JSON.stringify(await source.inputs({ id: 'research' } as never))).not.toBe(before)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the research agent holds the gate tools and no shell', async () => {
  const agents = loadAgentDefinitions(join(import.meta.dir, '..', '..', '..', 'agents')).filter((a) =>
    a.name.startsWith('research'),
  )
  expect(agents.map((a) => a.name)).toEqual(['research'])
  const [agent] = agents
  expect(agent?.permissions?.shell).toBeUndefined()
  expect(agent?.permissions?.rules?.map((r) => r.action)).toEqual([...GATE_TOOLS])
  const plugin = agent?.plugins?.['agw-tools.ts'] ?? ''
  for (const tool of GATE_TOOLS) expect(plugin).toContain(`name: '${tool}'`)
  expect(plugin.match(/name: '/g)).toHaveLength(GATE_TOOLS.length)
})
