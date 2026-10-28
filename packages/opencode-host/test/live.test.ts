import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Usage } from '@agent-workflows/runtime'
import { createClient, type OpenCodeHandle, OpenCodeHost, OpenCodeServer } from '../src/index.ts'

// The real `opencode` 2.0.32 on the cheapest opencode-wire route, one session, well under $0.05. Run with:
//   AGW_LIVE=1 secrets-run run --env-file=.env.tpl -- timeout 600 bun test packages/opencode-host
// open → prompt → SIGKILL the server mid-turn → the supervisor restarts it → wait re-attaches and finishes, with the
// one prompt the step sent. The location's AGENTS.md and skill must reach the model; the user's own skills
// (`~/.claude/skills`, `~/.agents/skills`) and the shell tool (denied by default) must not.
const live = process.env.AGW_LIVE === '1'
const name = 'live: kill the server mid-turn, re-attach, finish without a second prompt'

test.skipIf(!live)(
  live ? name : `${name} (skipped: runs only with AGW_LIVE=1)`,
  async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'och-live-'))
    const server = new OpenCodeServer({ stateDir, livenessIntervalMs: 1_000 })
    const host = new OpenCodeHost({
      server,
      stateDir,
      agents: [
        {
          name: 'live-probe',
          route: 'check',
          agentsMd: '# Rules\n\nEnd every reply with the single word PINEAPPLE on its own line.\n',
          skills: {
            'counting-words/SKILL.md':
              '---\nname: counting-words\ndescription: How to spell numbers as English words.\n---\nUse lowercase words.\n',
          },
        },
      ],
    })
    const t0 = Date.now()
    try {
      await server.start()
      const client = createClient(() => server.endpoint())
      const handle = (await host.open({
        runId: 'live',
        stepId: 'probe',
        key: 'live:probe',
        agent: 'live-probe',
        prompt: '',
      })) as OpenCodeHandle
      const prompt =
        'Do not call any tool. First line: the names of the skills available to you, comma separated. ' +
        'Second line: the names of the tools available to you, comma separated. ' +
        'Then write the numbers from one to one hundred as English words, one per line.'
      await host.prompt(handle, prompt)

      // Kill once the turn is running and streaming.
      for (;;) {
        const [messages, active] = await Promise.all([client.messages(handle.sessionId), client.active()])
        if (active.has(handle.sessionId) && messages.some((m) => m.type === 'assistant')) break
        await Bun.sleep(100)
      }
      const killed = server.pid as number
      process.kill(killed, 'SIGKILL')
      const killedAt = Date.now() - t0

      let progress = 0
      const result = await host.wait(handle, {
        signal: AbortSignal.timeout(300_000), // test bound only; the host itself has no cap
        onProgress: () => progress++,
        onTool: async () => {},
      })
      const messages = await client.messages(handle.sessionId)
      const usage = result.usage as Usage
      const report = {
        killedAtMs: killedAt,
        totalMs: Date.now() - t0,
        restarts: server.restartCount,
        newPid: server.pid !== killed,
        progressEvents: progress,
        messageTypes: messages.map((m) => `${m.type}${m.metadata?.agw?.kind ? `:${m.metadata.agw.kind}` : ''}`),
        usage,
        outputHead: String(result.output).split('\n').slice(0, 4),
        outputTail: String(result.output).split('\n').slice(-2),
      }
      console.log(`live opencode-host ${JSON.stringify(report, null, 2)}`)

      expect(server.restartCount).toBe(1)
      expect(messages.filter((m) => m.type === 'user')).toHaveLength(1)
      expect(messages.filter((m) => m.metadata?.agw?.kind === 'resume')).toHaveLength(1)
      expect(String(result.output)).toContain('PINEAPPLE')
      const [skillLine = '', toolLine = ''] = String(result.output).split('\n')
      const names = (line: string) =>
        line
          .toLowerCase()
          .split(/[\s,]+/)
          .filter(Boolean)
      expect(names(skillLine)).toContain('counting-words')
      const userSkills = ['.claude/skills', '.agents/skills']
        .map((d) => join(homedir(), d))
        .filter(existsSync)
        .flatMap((d) => readdirSync(d))
      expect(userSkills.length).toBeGreaterThan(0) // the probe means something only if the user has skills
      expect(names(skillLine).filter((n) => userSkills.includes(n))).toEqual([])
      expect(names(toolLine).filter((n) => n === 'shell' || n === 'bash')).toEqual([])
      expect(usage.tokens.input).toBeGreaterThan(0)
      expect(usage.cost ?? 1).toBeLessThan(0.05)
    } finally {
      host.close()
      await server.close({ stop: true })
      rmSync(stateDir, { recursive: true, force: true })
    }
  },
  600_000,
)
