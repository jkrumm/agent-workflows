import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient, type Message, type OpenCodeHandle, OpenCodeHost, OpenCodeServer } from '../src/index.ts'
import { inputId } from '../src/session.ts'

// Measures, on the real `opencode` 2.0.32 on the cheapest route, what a synthetic input posted WHILE a turn runs does:
// is it read within the running turn (it lands between that turn's tool calls, before the turn's idle), or queued as a
// separate turn after the current one? Run with:
//   AGW_LIVE=1 secrets-run run --env-file=.env.tpl -- timeout 600 bun test packages/opencode-host/test/live-nudge.test.ts
// The probe never uses `host.wait` (the host's own nudge would interfere): it polls the messages itself.
const live = process.env.AGW_LIVE === '1'
const name = 'live: where a synthetic note posted mid-turn lands'

const summary = (m: Message) => {
  const tools = (m.content ?? []).filter((p) => p.type === 'tool')
  const text = (m.content ?? [])
    .filter((p) => p.type === 'text')
    .map((p) => p.text ?? '')
    .join('')
  return [
    m.type,
    m.finish ? `[finish=${m.finish}]` : '',
    m.metadata?.agw?.kind ? `:${m.metadata.agw.kind}` : '',
    tools.length > 0 ? ` tools=${tools.map((t) => `${t.name}/${t.state?.status}`).join(',')}` : '',
    text ? ` text=${JSON.stringify(text.slice(0, 120))}` : '',
    m.type === 'user' || m.type === 'synthetic' ? ` text=${JSON.stringify((m.text ?? '').slice(0, 60))}` : '',
  ].join('')
}

test.skipIf(!live)(
  live ? name : `${name} (skipped: runs only with AGW_LIVE=1)`,
  async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'och-live-nudge-'))
    const server = new OpenCodeServer({ stateDir, livenessIntervalMs: 1_000 })
    const host = new OpenCodeHost({
      server,
      stateDir,
      agents: [{ name: 'looper', route: 'check', agentsMd: '# Rules\n\nFollow the instructions exactly.\n' }],
    })
    try {
      await server.start()
      const client = createClient(() => server.endpoint())
      const handle = (await host.open({
        runId: 'live',
        stepId: 'loop',
        key: 'live:loop',
        agent: 'looper',
        prompt: '',
      })) as OpenCodeHandle
      const file = join(handle.directory, 'AGENTS.md')
      const prompt =
        `Use the read tool on the file ${file}. Do this 12 separate times, strictly ONE tool call per assistant turn, ` +
        'waiting for each result before the next call; never several calls at once. After the 12th read, reply with the ' +
        'single word DONE.'
      await host.prompt(handle, prompt)

      const noteText =
        'SYSTEM NOTE: stop calling tools now. Reply immediately with the single word NUDGED and nothing else.'
      let noteId: string | null = null
      let postedAfterTools = 0
      let calm = 0
      const deadline = Date.now() + 240_000
      while (Date.now() < deadline) {
        const [messages, active, inbox] = await Promise.all([
          client.messages(handle.sessionId),
          client.active(),
          client.inbox(handle.sessionId),
        ])
        const tools = messages.flatMap((m) => (m.content ?? []).filter((p) => p.type === 'tool'))
        if (noteId === null && tools.length >= 3 && active.has(handle.sessionId)) {
          noteId = inputId(handle.sessionId, 'nudge', 'live-probe')
          postedAfterTools = tools.length
          await client.synthetic(handle.sessionId, {
            id: noteId,
            text: noteText,
            description: 'agw repeat-tool nudge',
            metadata: { agw: { kind: 'nudge' } },
          })
        }
        const last = messages.at(-1)
        const settled = !active.has(handle.sessionId) && inbox.length === 0 && last?.type === 'idle'
        calm = settled ? calm + 1 : 0
        if (noteId !== null && calm >= 3) break
        await Bun.sleep(300)
      }
      const messages = await client.messages(handle.sessionId)
      const order = messages.map((m, i) => `${String(i).padStart(2)} ${summary(m)}`)
      const noteIndex = messages.findIndex((m) => m.id === noteId)
      const idlesBeforeNote = messages.slice(0, Math.max(noteIndex, 0)).filter((m) => m.type === 'idle').length
      const toolsAfterNote = messages
        .slice(noteIndex + 1)
        .flatMap((m) => (m.content ?? []).filter((p) => p.type === 'tool')).length
      const report = {
        toolCallsWhenPosted: postedAfterTools,
        noteIndex,
        idlesBeforeNote,
        idlesTotal: messages.filter((m) => m.type === 'idle').length,
        toolCallsTotal: messages.flatMap((m) => (m.content ?? []).filter((p) => p.type === 'tool')).length,
        toolCallsAfterNote: toolsAfterNote,
        order,
      }
      console.log(`live nudge probe ${JSON.stringify(report, null, 2)}`)
      // Measured 2026-10-28 on 2.0.32 (check route, 3 tool calls, 8 s): the note lands between the turn's own assistant
      // messages (read, read, read, synthetic, assistant "NUDGED", idle): in-turn, one idle in total.
      expect(noteIndex).toBeGreaterThan(-1)
      expect(idlesBeforeNote).toBe(0)
      expect(report.idlesTotal).toBe(1)
      expect(messages[noteIndex + 1]?.type).toBe('assistant')
    } finally {
      host.close()
      await server.close({ stop: true })
      rmSync(stateDir, { recursive: true, force: true })
    }
  },
  600_000,
)
