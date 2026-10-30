import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCapabilities, createRegistry } from '@agent-workflows/capabilities'
import { fakeTransports } from '@agent-workflows/capabilities/testing'
import {
  type OpenCodeHandle,
  OpenCodeHost,
  OpenCodeServer,
  resolveOpencodeBinary,
} from '@agent-workflows/opencode-host'
import { loadAgentDefinitions } from '../src/agents.ts'
import { type CapabilityCall, ToolGate } from '../src/tool-gate/index.ts'
import { memoryToolLedger } from '../src/workflows/research/ledger.ts'
import { BRAIN_TOOLS, brainGrant, evidence } from '../src/workflows/brain/tools.ts'

// The brain agent on the real `opencode` against a scripted fake model (no spend): the plugin in their location reaches
// the tool gate with the session id, the real brain capabilities run on a temp vault, and the agent's own file tools
// cannot reach the vault around the gate. The route is overridden to the OpenAI-compatible fake (the production route is
// Terra on the Responses wire, which the review and check agents already exercise); the agent, its plugin and its
// permissions are the production ones. Skipped where no opencode is installed (CI runners).
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
    hostname: '127.0.0.1',
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

const ANSWER = JSON.stringify({
  found: true,
  answer: 'Two billing lanes.',
  citations: [{ path: 'wiki/engineering/model-routing.md', claim: 'two billing lanes' }],
})

const root = mkdtempSync(join(tmpdir(), 'agw-brain-oc-'))
const vault = join(root, 'vault')
const stateDir = join(root, 'state')
const SECRET_LINE = 'Two billing lanes, kept private.'
const ledger = memoryToolLedger()
const registry = createRegistry(
  createCapabilities({ transports: fakeTransports({}), env: {} }, {}, {}, { env: { AGW_BRAIN_DIR: vault } }),
)
const gate = new ToolGate({
  stateDir,
  call: (id, input, scope) => (registry as unknown as { call: CapabilityCall }).call(id, input, scope),
})

beforeAll(() => {
  mkdirSync(join(vault, 'wiki', 'engineering'), { recursive: true })
  mkdirSync(join(vault, 'Inbox'), { recursive: true })
  writeFileSync(
    join(vault, 'wiki', 'engineering', 'model-routing.md'),
    `---\ntype: Concept\n---\n# Model routing\n\n${SECRET_LINE}\n`,
  )
  writeFileSync(join(vault, 'Inbox', 'raw.md'), 'inbox only\n')
  gate.ensureServing()
})
afterAll(async () => {
  await gate.close()
  rmSync(root, { recursive: true, force: true })
})

async function runAgent(script: Step[]) {
  const model = fakeModel(script)
  const env = {
    ...process.env,
    IU_API_KEY: 'fake',
    IU_BASE_URL: `http://127.0.0.1:${model.server.port}/anthropic`,
    AGW_ROUTES: JSON.stringify({ 'brain.agent': { model: 'deepseek-v4.1-flash' } }),
  }
  const server = new OpenCodeServer({ stateDir, env, livenessIntervalMs: 1_000 })
  const agents = loadAgentDefinitions(join(import.meta.dir, '..', '..', '..', 'agents')).filter(
    (a) => a.name === 'brain',
  )
  const host = new OpenCodeHost({ server, stateDir, env, agents })
  const runId = `r${Math.random().toString(36).slice(2)}`
  const close = gate.open({ runId, stepId: 'brain', ...brainGrant(ledger), tools: BRAIN_TOOLS })
  try {
    await server.start()
    const handle = (await host.open({
      runId,
      stepId: 'brain',
      key: `${runId}:brain`,
      agent: 'brain',
      prompt: '',
      options: { output: 'json' },
    })) as OpenCodeHandle
    await host.prompt(handle, 'How many billing lanes are there?')
    const result = await host.wait(handle, {
      signal: AbortSignal.timeout(90_000),
      onProgress: () => {},
      onTool: async () => {},
    })
    return { result, seen: model.seen, rows: await ledger.read(runId, 'brain') }
  } finally {
    await close()
    host.close()
    await server.close({ stop: true })
    void model.server.stop(true)
  }
}

const toolContent = (seen: Seen[], turn: number) => String(seen[turn]?.messages.find((m) => m.role === 'tool')?.content)

test.skipIf(!binary)(
  'the brain agent reads the vault through the gate: it is offered its two tools, refusals reach the model',
  async () => {
    const { seen, rows, result } = await runAgent([
      { tool: 'brain_search', args: { query: 'billing' } },
      { tool: 'brain_read', args: { note: '[[model-routing]]' } },
      { tool: 'brain_read', args: { note: 'Inbox/raw.md' } },
      { text: ANSWER },
    ])
    // Deny by default, then the agent's allow rules: no OpenCode web or shell tools, and no tool of another agent.
    expect(seen[0]?.tools).toEqual(['brain_read', 'brain_search', 'glob', 'grep', 'read', 'skill'])
    expect(toolContent(seen, 1)).toContain('wiki/engineering/model-routing.md')
    const toolMessages = seen[3]?.messages.filter((m) => m.role === 'tool').map((m) => String(m.content)) ?? []
    expect(toolMessages[1]).toContain(SECRET_LINE)
    expect(toolMessages[2]).toContain('"found":false')
    expect(toolMessages[2]).not.toContain('inbox only')
    expect(evidence(rows)).toEqual({
      read: ['wiki/engineering/model-routing.md'],
      counts: { brain_search: 1, brain_read: 2 },
    })
    expect(result.output as Record<string, unknown>).toMatchObject({ found: true, answer: 'Two billing lanes.' })
  },
  120_000,
)

test.skipIf(!binary)(
  "the agent's own file tools cannot reach the vault around the gate",
  async () => {
    const note = join(vault, 'wiki', 'engineering', 'model-routing.md')
    const { seen } = await runAgent([
      { tool: 'read', args: { path: note } },
      { tool: 'grep', args: { pattern: 'billing', path: vault } },
      { text: ANSWER },
    ])
    for (const turn of [1, 2]) {
      const content =
        seen[turn]?.messages
          .filter((m) => m.role === 'tool')
          .map((m) => String(m.content))
          .join('\n') ?? ''
      expect(content).not.toContain(SECRET_LINE)
      expect(content.toLowerCase()).toMatch(/denied|not allowed|permission|outside|reject/)
    }
  },
  120_000,
)
