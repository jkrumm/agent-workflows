import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCapabilities, createRegistry } from '@agent-workflows/capabilities'
import { fakeTransports } from '@agent-workflows/testing/transports'
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
// cannot reach the vault around the gate. The fake speaks the Anthropic Messages wire, the leg of the production route
// (`brain.agent` is Haiku, no override); the agent, its plugin and its permissions are the production ones. Skipped where no opencode is installed (CI runners).
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
    AGW_GATEWAY_TOOL_TOKEN: 'fake',
    AGW_GATEWAY_URL: `http://127.0.0.1:${model.server.port}`,
  }
  const server = new OpenCodeServer({ stateDir, env, livenessIntervalMs: 1_000 })
  const agents = loadAgentDefinitions(join(import.meta.dir, '..', '..', '..', 'agents')).filter(
    (a) => a.name === 'brain',
  )
  const host = new OpenCodeHost({ server, stateDir, agents })
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
      // A text step, as the workflow runs it: its draft is parsed by the workflow, not the host.
      attribution: { runId, rootId: runId, workflow: 'brain', step: 'brain', purpose: 'verify' },
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
    expect(JSON.parse(result.output as string) as Record<string, unknown>).toMatchObject({
      found: true,
      answer: 'Two billing lanes.',
    })
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
