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
import { ToolGate } from '../src/workflows/research/gate.ts'
import { memoryToolLedger } from '../src/workflows/research/ledger.ts'

// The research agents on the real `opencode` 2.0.32 against a scripted fake model (no spend): the plugin in their
// location reaches the tool gate with the session id, the gate refuses an ungranted tool, and the DeepSeek route keeps
// the wire rules (reasoning passed back verbatim, cache reads recorded and priced). Skipped where no opencode is
// installed (CI runners).
let binary: string | null = null
try {
  binary = resolveOpencodeBinary()
} catch {
  binary = null
}

type Step = { tool: string; args: Record<string, unknown> } | { text: string }
type Seen = { tools: string[]; messages: Record<string, unknown>[] }

/** An OpenAI-compatible streaming endpoint that plays `script` turn by turn and records every request. */
function fakeModel(script: Step[]) {
  const seen: Seen[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as {
        tools?: { function: { name: string } }[]
        messages: Record<string, unknown>[]
      }
      seen.push({ tools: (body.tools ?? []).map((t) => t.function.name).sort(), messages: body.messages })
      const step = script[Math.min(seen.length - 1, script.length - 1)] as Step
      const chunk = (delta: unknown, finish: string | null = null) =>
        `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
      const reasoning = `REASONING-${seen.length}`
      let out = chunk({ role: 'assistant', reasoning_content: reasoning })
      out +=
        'tool' in step
          ? chunk({
              tool_calls: [
                {
                  index: 0,
                  id: `call_${seen.length}`,
                  type: 'function',
                  function: { name: step.tool, arguments: JSON.stringify(step.args) },
                },
              ],
            }) + chunk({}, 'tool_calls')
          : chunk({ content: step.text }) + chunk({}, 'stop')
      const usage = {
        prompt_tokens: 1_000,
        completion_tokens: 100,
        total_tokens: 1_100,
        prompt_tokens_details: { cached_tokens: 800 },
      }
      out += `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [], usage })}\n\ndata: [DONE]\n\n`
      return new Response(out, { headers: { 'content-type': 'text/event-stream' } })
    },
  })
  return { server, seen }
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
  ledger,
  engine: () => null,
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
    IU_API_KEY: 'fake',
    IU_BASE_URL: `http://127.0.0.1:${model.server.port}/anthropic`,
    AGW_ROUTES: '',
  }
  const server = new OpenCodeServer({ stateDir, env, livenessIntervalMs: 1_000 })
  const agents = loadAgentDefinitions(join(import.meta.dir, '..', '..', '..', 'agents')).filter((a) => a.name === agent)
  const host = new OpenCodeHost({ server, stateDir, env, agents })
  const runId = `r${Math.random().toString(36).slice(2)}`
  const key = `${runId}:research`
  const close = gate.open({ runId, stepId: 'research', tools: grantTools as never })
  try {
    await server.start()
    const handle = (await host.open({
      runId,
      stepId: 'research',
      key,
      agent,
      prompt: '',
      options: { output: 'json' },
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
  'a research agent calls the platform web tools through the gate; the DeepSeek wire rules hold',
  async () => {
    const { result, seen, entries } = await runAgent(
      'research-agent-focused',
      [{ tool: 'web_search', args: { query: 'postgres default port' } }, { text: REPORT }],
      ['web_search', 'web_fetch'],
    )
    // The model is offered exactly the agent's tools (deny by default, then its allow rules): no OpenCode web tools.
    expect(seen[0]?.tools).toEqual(['glob', 'grep', 'read', 'skill', 'web_fetch', 'web_search'])
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
    // DeepSeek wire rules (concept §8): the first turn's reasoning goes back verbatim with its tool call.
    const assistant = seen[1]?.messages.find((m) => m.role === 'assistant')
    expect(JSON.stringify(assistant)).toContain('REASONING-1')
    // Cache reads are recorded and priced with the route's rate.
    const usage = result.usage
    expect(usage?.tokens.cacheRead).toBe(1_600)
    expect(usage?.cost).toBeGreaterThan(0)
    expect(result.output as Record<string, unknown>).toMatchObject({ report: '## Bottom line\nPort 5432.' })
    // The gate's key file is the user's only.
    expect(statSync(join(stateDir, 'research', 'gate.json')).mode & 0o777).toBe(0o600)
  },
  120_000,
)

test.skipIf(!binary)(
  'the gate refuses a tool the grant does not hold, and the model sees the refusal',
  async () => {
    const { seen, entries } = await runAgent(
      'research-agent-yolo',
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
    const keyFile = join(stateDir, 'research', 'gate.json')
    const { seen } = await runAgent(
      'research-agent-yolo',
      [{ tool: 'read', args: { path: keyFile } }, { text: REPORT }],
      [],
    )
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
    cpSync(
      join(import.meta.dir, '..', '..', '..', 'agents', 'research-agent-focused'),
      join(agentsDir, 'research-agent-focused'),
      { recursive: true },
    )
    const source = fsFingerprintSource({
      agentsDir,
      workflows: { research: [{ agent: 'research-agent-focused', route: 'research.agent' }] },
      opencodeBin: binary ?? '/bin/echo',
    })
    const before = JSON.stringify(await source.inputs({ id: 'research' } as never))
    expect(before).toContain('plugins/agw-tools.ts')
    writeFileSync(join(agentsDir, 'research-agent-focused', 'plugins', 'agw-tools.ts'), '// changed\n')
    expect(JSON.stringify(await source.inputs({ id: 'research' } as never))).not.toBe(before)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('every research agent carries the same plugin', async () => {
  const agents = loadAgentDefinitions(join(import.meta.dir, '..', '..', '..', 'agents')).filter((a) =>
    a.name.startsWith('research-'),
  )
  expect(agents.map((a) => a.name)).toEqual([
    'research-agent-focused',
    'research-agent-yolo',
    'research-pilot-focused',
    'research-pilot-yolo',
  ])
  expect(new Set(agents.map((a) => a.plugins?.['agw-tools.ts'])).size).toBe(1)
  for (const agent of agents) expect(agent.permissions?.shell).toBeUndefined()
})
