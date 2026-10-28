import { expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
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

const guard = 'live: a non-shell agent cannot read, search or write outside its location'

test.skipIf(!live)(
  live ? guard : `${guard} (skipped: runs only with AGW_LIVE=1)`,
  async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'och-live-'))
    const server = new OpenCodeServer({ stateDir, livenessIntervalMs: 1_000 })
    const host = new OpenCodeHost({
      server,
      stateDir,
      agents: [{ name: 'reader', route: 'check', agentsMd: '# Rules\n\nFollow the instructions exactly.\n' }],
    })
    const outside = join(tmpdir(), `agw-probe-${process.pid}-${Date.now()}.txt`)
    try {
      await server.start()
      const secretPath = join(stateDir, 'opencode', 'server.json')
      const { password } = JSON.parse(readFileSync(secretPath, 'utf8')) as { password: string }
      const client = createClient(() => server.endpoint())
      const handle = (await host.open({
        runId: 'live',
        stepId: 'guard',
        key: 'live:guard',
        agent: 'reader',
        prompt: '',
      })) as OpenCodeHandle
      const prompt = [
        'Make exactly these tool calls, one after the other, even if one fails:',
        '1. read the file /etc/hosts',
        `2. read the file ${secretPath}`,
        '3. glob the pattern "*" in the directory /etc',
        `4. grep for "password" in the directory ${join(stateDir, 'opencode')}`,
        `5. write the text "probe" to the new file ${outside}`,
        'Then answer with one line per call: its number and OK or REFUSED. Nothing else.',
      ].join('\n')
      await host.prompt(handle, prompt)
      const tools: { tool: string; status: string; target: string; reason: string }[] = []
      const result = await host.wait(handle, {
        signal: AbortSignal.timeout(300_000), // test bound only
        onProgress: () => {},
        onTool: async () => {},
      })
      for (const m of await client.messages(handle.sessionId)) {
        for (const p of m.content ?? []) {
          if (p.type !== 'tool') continue
          const input = p.state?.input ?? {}
          const target = String(input.filePath ?? input.path ?? input.file ?? input.directory ?? input.pattern ?? '')
          const error = p.state?.error
          const reason = (typeof error === 'string' ? error : (error?.message ?? '')).slice(0, 160)
          tools.push({ tool: p.name ?? '?', status: p.state?.status ?? '?', target, reason })
        }
      }
      const redact = (text: string) => text.replaceAll(password, '<password>')
      const report = {
        tools,
        answer: redact(String(result.output)),
        usage: result.usage,
        outsideFileExists: existsSync(outside),
      }
      console.log(`live opencode-host guard ${redact(JSON.stringify(report, null, 2))}`)

      expect(tools.length).toBeGreaterThanOrEqual(4)
      expect(tools.filter((t) => t.status === 'completed')).toEqual([])
      expect(existsSync(outside)).toBe(false)
      const all = JSON.stringify(await client.messages(handle.sessionId))
      expect(all.includes(password)).toBe(false)
      expect(all.includes('localhost')).toBe(false) // /etc/hosts content never reached the session
    } finally {
      host.close()
      await server.close({ stop: true })
      rmSync(stateDir, { recursive: true, force: true })
      rmSync(outside, { force: true })
    }
  },
  600_000,
)

const allow = 'live: allowDirectories lets an agent read one directory, and only that, without editing it'

test.skipIf(!live)(
  live ? allow : `${allow} (skipped: runs only with AGW_LIVE=1)`,
  async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'och-live-'))
    const server = new OpenCodeServer({ stateDir, livenessIntervalMs: 1_000 })
    const host = new OpenCodeHost({
      server,
      stateDir,
      agents: [
        {
          name: 'repo-reader',
          route: 'check',
          agentsMd: '# Rules\n\nFollow the instructions exactly.\n',
        },
      ],
    })
    const root = mkdtempSync(join(tmpdir(), 'agw-allow-'))
    const repo = join(root, 'repo')
    const lookalike = join(root, 'repo-evil') // shares the allowed directory's name as a prefix
    const outside = join(root, 'other')
    for (const dir of [join(repo, 'sub'), lookalike, outside]) mkdirSync(dir, { recursive: true })
    writeFileSync(join(repo, 'top.txt'), 'TOKEN-TOP-4417\n')
    writeFileSync(join(repo, 'sub', 'deep.txt'), 'TOKEN-DEEP-5528\n')
    writeFileSync(join(lookalike, 'near.txt'), 'TOKEN-NEAR-6639\n')
    writeFileSync(join(outside, 'far.txt'), 'TOKEN-FAR-7740\n')
    try {
      await server.start()
      const client = createClient(() => server.endpoint())
      const handle = (await host.open({
        runId: 'live',
        stepId: 'allow',
        key: 'live:allow',
        agent: 'repo-reader',
        prompt: '',
        options: { allowDirectories: [repo] },
      })) as OpenCodeHandle
      const prompt = [
        'Make exactly these tool calls, one after the other, even if one fails:',
        `1. read the file ${join(repo, 'top.txt')}`,
        `2. read the file ${join(repo, 'sub', 'deep.txt')}`,
        `3. glob the pattern "**/*.txt" in the directory ${repo}`,
        `4. grep for "TOKEN" in the directory ${repo}`,
        `5. read the file ${join(lookalike, 'near.txt')}`,
        `6. read the file ${join(outside, 'far.txt')}`,
        `7. write the text "changed" to the existing file ${join(repo, 'top.txt')}`,
        `8. write the text "probe" to the new file ${join(repo, 'new.txt')}`,
        'Then answer with one line per call: its number and OK or REFUSED. Nothing else.',
      ].join('\n')
      await host.prompt(handle, prompt)
      const result = await host.wait(handle, {
        signal: AbortSignal.timeout(300_000), // test bound only
        onProgress: () => {},
        onTool: async () => {},
      })
      const tools: { tool: string; status: string; target: string; reason: string }[] = []
      for (const m of await client.messages(handle.sessionId)) {
        for (const p of m.content ?? []) {
          if (p.type !== 'tool') continue
          const input = p.state?.input ?? {}
          const target = String(input.filePath ?? input.path ?? input.file ?? input.directory ?? input.pattern ?? '')
          const error = p.state?.error
          const reason = (typeof error === 'string' ? error : (error?.message ?? '')).slice(0, 160)
          tools.push({ tool: p.name ?? '?', status: p.state?.status ?? '?', target, reason })
        }
      }
      const files = {
        top: readFileSync(join(repo, 'top.txt'), 'utf8'),
        newFileExists: existsSync(join(repo, 'new.txt')),
      }
      const report = { tools, answer: result.output, usage: result.usage, files }
      console.log(`live opencode-host allowDirectories ${JSON.stringify(report, null, 2)}`)

      const completed = (needle: string) => tools.some((t) => t.status === 'completed' && t.target.includes(needle))
      const refused = (needle: string) =>
        tools.some((t) => t.status === 'error' && t.reason.includes('external_directory') && t.target.includes(needle))
      expect(completed('top.txt')).toBe(true)
      expect(completed(join('sub', 'deep.txt'))).toBe(true) // a file below the directory
      expect(tools.filter((t) => t.tool === 'glob' || t.tool === 'grep').every((t) => t.status === 'completed')).toBe(
        true,
      )
      expect(tools.some((t) => t.tool === 'glob' || t.tool === 'grep')).toBe(true)
      expect(refused('near.txt')).toBe(true) // a sibling that only shares the name's prefix
      expect(refused('far.txt')).toBe(true)
      expect(files.top).toBe('TOKEN-TOP-4417\n') // no edit inside the allowed directory
      expect(files.newFileExists).toBe(false)
      expect(readFileSync(join(lookalike, 'near.txt'), 'utf8')).toBe('TOKEN-NEAR-6639\n')
      expect(existsSync(join(outside, 'new.txt'))).toBe(false)
      const all = JSON.stringify(await client.messages(handle.sessionId))
      expect(all.includes('TOKEN-NEAR-6639')).toBe(false)
      expect(all.includes('TOKEN-FAR-7740')).toBe(false)
    } finally {
      host.close()
      await server.close({ stop: true })
      rmSync(stateDir, { recursive: true, force: true })
      rmSync(root, { recursive: true, force: true })
    }
  },
  600_000,
)

const link = 'live: a symlink inside an allowed directory (measurement: the grant follows the path, not the link)'

test.skipIf(!live)(
  live ? link : `${link} (skipped: runs only with AGW_LIVE=1)`,
  async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'och-live-'))
    const server = new OpenCodeServer({ stateDir, livenessIntervalMs: 1_000 })
    const host = new OpenCodeHost({
      server,
      stateDir,
      agents: [
        {
          name: 'link-reader',
          route: 'check',
          agentsMd: '# Rules\n\nFollow the instructions exactly.\n',
        },
      ],
    })
    const root = mkdtempSync(join(tmpdir(), 'agw-link-'))
    const repo = join(root, 'repo')
    const outside = join(root, 'other')
    mkdirSync(repo)
    mkdirSync(outside)
    writeFileSync(join(repo, 'inside.txt'), 'TOKEN-INSIDE-1111\n')
    writeFileSync(join(outside, 'secret.txt'), 'TOKEN-OUTSIDE-2222\n')
    symlinkSync(outside, join(repo, 'dirlink')) // repo/dirlink -> a directory outside the grant
    symlinkSync(join(outside, 'secret.txt'), join(repo, 'filelink.txt')) // repo/filelink.txt -> a file outside it
    try {
      await server.start()
      const client = createClient(() => server.endpoint())
      const handle = (await host.open({
        runId: 'live',
        stepId: 'link',
        key: 'live:link',
        agent: 'link-reader',
        prompt: '',
        options: { allowDirectories: [repo] },
      })) as OpenCodeHandle
      await host.prompt(
        handle,
        [
          'Make exactly these tool calls, one after the other, even if one fails:',
          `1. read the file ${join(repo, 'inside.txt')}`,
          `2. read the file ${join(repo, 'filelink.txt')}`,
          `3. read the file ${join(repo, 'dirlink', 'secret.txt')}`,
          `4. glob the pattern "*" in the directory ${join(repo, 'dirlink')}`,
          `5. grep for "TOKEN" in the directory ${join(repo, 'dirlink')}`,
          'Then answer with one line per call: its number and OK or REFUSED. Nothing else.',
        ].join('\n'),
      )
      const result = await host.wait(handle, {
        signal: AbortSignal.timeout(300_000), // test bound only
        onProgress: () => {},
        onTool: async () => {},
      })
      const tools: { tool: string; status: string; target: string; reason: string }[] = []
      for (const m of await client.messages(handle.sessionId)) {
        for (const p of m.content ?? []) {
          if (p.type !== 'tool') continue
          const input = p.state?.input ?? {}
          const target = String(input.filePath ?? input.path ?? input.directory ?? input.pattern ?? '')
          const error = p.state?.error
          const reason = (typeof error === 'string' ? error : (error?.message ?? '')).slice(0, 160)
          tools.push({ tool: p.name ?? '?', status: p.state?.status ?? '?', target, reason })
        }
      }
      const all = JSON.stringify(await client.messages(handle.sessionId))
      const report = { tools, answer: result.output, outsideTokenInSession: all.includes('TOKEN-OUTSIDE-2222') }
      console.log(`live opencode-host symlink ${JSON.stringify(report, null, 2)}`)
      // Measured on 2.0.32: the grant is matched against the path the agent names, so a link inside the allowed directory
      // is followed out of it (read, glob and grep). If a newer OpenCode resolves links, this fails: drop the clone
      // symlink removal's "why" and the README's accepted risk, then.
      expect(tools).toHaveLength(5)
      expect(tools.every((t) => t.status === 'completed')).toBe(true)
      expect(all.includes('TOKEN-OUTSIDE-2222')).toBe(true)
    } finally {
      host.close()
      await server.close({ stop: true })
      rmSync(stateDir, { recursive: true, force: true })
      rmSync(root, { recursive: true, force: true })
    }
  },
  600_000,
)
