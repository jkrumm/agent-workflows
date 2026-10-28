import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentDefinition, PermissionRule } from '../src/index.ts'
import { createClient, type OpenCodeHandle, OpenCodeHost, OpenCodeServer, sessionPermissions } from '../src/index.ts'

// Measures, on the real `opencode` 2.0.32 on the cheapest route, what the deny-by-default session policy
// (`sessionPermissions`) lets through: read, glob, grep and skill work; webfetch, websearch, subagent, edit, write,
// shell and Code Mode `execute` are refused without ending the turn; an agent that opts in to webfetch gets it. Run with:
//   AGW_LIVE=1 secrets-run run --env-file=.env.tpl -- timeout 900 bun test packages/opencode-host/test/live-permissions.test.ts
const live = process.env.AGW_LIVE === '1'
const name = 'live: deny-by-default permissions refuse every non-read tool, an opt-in gets its tool'

const AGENTS_MD = '# Rules\n\nFollow the instructions exactly. A refused tool call is expected: report it and go on.\n'
const SKILL =
  '---\nname: probe-skill\ndescription: A probe skill; load it when asked.\n---\nThe skill word is KUMQUAT.\n'

const KNOWN_TOOLS = [
  'edit',
  'execute',
  'glob',
  'grep',
  'question',
  'read',
  'shell',
  'skill',
  'subagent',
  'webfetch',
  'websearch',
  'write',
]

/** The tool names on the answer's first line (a model that adds a remark after the list does not change the set). */
function toolNames(answer: string): string[] {
  const first = answer.split('\n').find((line) => line.trim() !== '') ?? ''
  return first
    .split(/[\s,]+/)
    .map((word) => word.replace(/[^a-z]/g, ''))
    .filter((word) => KNOWN_TOOLS.includes(word))
}

type ToolCall = { tool: string; status: string; input: string; reason: string }

async function run(
  agent: Pick<AgentDefinition, 'name' | 'permissions'>,
  options: { allowDirectories: string[] },
  prompt: string,
): Promise<{ tools: ToolCall[]; answer: string; usage: unknown }> {
  const stateDir = mkdtempSync(join(tmpdir(), 'och-live-'))
  const server = new OpenCodeServer({ stateDir, livenessIntervalMs: 1_000 })
  const host = new OpenCodeHost({
    server,
    stateDir,
    agents: [
      {
        ...agent,
        route: 'check',
        agentsMd: AGENTS_MD,
        skills: { 'probe-skill/SKILL.md': SKILL },
      },
    ],
  })
  try {
    await server.start()
    const client = createClient(() => server.endpoint())
    const handle = (await host.open({
      runId: 'live',
      stepId: agent.name,
      key: `live:${agent.name}`,
      agent: agent.name,
      prompt: '',
      options,
    })) as OpenCodeHandle
    await host.prompt(handle, prompt)
    const result = await host.wait(handle, {
      signal: AbortSignal.timeout(400_000), // test bound only; the host itself has no cap
      onProgress: () => {},
      onTool: async () => {},
    })
    const tools: ToolCall[] = []
    for (const m of await client.messages(handle.sessionId)) {
      for (const p of m.content ?? []) {
        if (p.type !== 'tool') continue
        const error = p.state?.error
        tools.push({
          tool: p.name ?? '?',
          status: p.state?.status ?? '?',
          input: JSON.stringify(p.state?.input ?? {}).slice(0, 300),
          reason: (typeof error === 'string' ? error : (error?.message ?? '')).slice(0, 300),
        })
      }
    }
    return { tools, answer: String(result.output), usage: result.usage }
  } finally {
    host.close()
    await server.close({ stop: true })
    rmSync(stateDir, { recursive: true, force: true })
  }
}

test.skipIf(!live)(
  live ? name : `${name} (skipped: runs only with AGW_LIVE=1)`,
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'agw-perm-'))
    const repo = join(root, 'repo')
    mkdirSync(repo)
    writeFileSync(join(repo, 'top.txt'), 'TOKEN-TOP-4417\n')
    // Where Code Mode would write if it could; inside the throwaway root, so a leak never lands in the shared /tmp.
    const canary = join(root, 'execute-canary.txt')
    try {
      const restricted = await run(
        { name: 'restricted' },
        { allowDirectories: [repo] },
        [
          'Make exactly these tool calls, one after the other, even if one is refused:',
          `1. read the file ${join(repo, 'top.txt')}`,
          `2. grep for "TOKEN" in the directory ${repo}`,
          `3. glob the pattern "*.txt" in the directory ${repo}`,
          '4. load the skill "probe-skill"',
          '5. webfetch https://example.com',
          '6. websearch for "opencode terminal agent"',
          '7. use the subagent tool to ask a subagent to run the shell command "echo hi"',
          `8. edit the file ${join(repo, 'top.txt')}: replace TOKEN with CHANGED`,
          `9. write the text "probe" to the new file ${join(repo, 'new.txt')}`,
          '10. use the shell tool to run: echo hi',
          `11. use the execute tool (Code Mode) with code that calls the webfetch tool on https://example.com and the write tool to create ${canary}, and return what happened`,
          'Then answer with one line per call: its number and OK or REFUSED. Nothing else.',
        ].join('\n'),
      )
      console.log(`live permissions restricted ${JSON.stringify(restricted, null, 2)}`)

      const optIn = await run(
        { name: 'fetcher', permissions: { rules: [{ action: 'webfetch', resource: '*', effect: 'allow' }] } },
        { allowDirectories: [repo] },
        [
          'Make exactly these tool calls, one after the other, even if one is refused:',
          '1. webfetch https://example.com',
          '2. websearch for "opencode terminal agent". The websearch tool may be missing from your tool list: call it anyway, by that name, and report the exact error you get.',
          'Then answer with one line per call: its number and OK or REFUSED. Nothing else.',
        ].join('\n'),
      )
      console.log(`live permissions opt-in ${JSON.stringify(optIn, null, 2)}`)

      const listing = (rules: PermissionRule[]) =>
        run(
          { name: 'lister', permissions: { rules } },
          { allowDirectories: [repo] },
          'Do not call any tool. List the exact names of every tool available to you, comma separated, in alphabetical order, nothing else.',
        ).then((r) => toolNames(r.answer))
      const rule = (action: string, effect: PermissionRule['effect']): PermissionRule => ({
        action,
        resource: '*',
        effect,
      })
      const listings = {
        baseline: await listing([]),
        withoutGlobGrepSkill: await listing([rule('glob', 'deny'), rule('grep', 'deny'), rule('skill', 'deny')]),
        withoutRead: await listing([rule('read', 'deny')]),
        optInEdit: await listing([rule('edit', 'allow')]),
        optInWebsearch: await listing([rule('websearch', 'allow')]),
        optInSubagent: await listing([rule('subagent', 'allow')]),
        optInExecute: await listing([rule('execute', 'allow')]),
        optInShell: await listing([rule('shell', 'allow')]),
      }
      console.log(`live permissions listings ${JSON.stringify(listings, null, 2)}`)

      // Code Mode: `execute` opted in, everything else it could reach (webfetch, edit/write, shell) not.
      const executeOnly = await run(
        { name: 'executor', permissions: { rules: [rule('execute', 'allow')] } },
        { allowDirectories: [repo] },
        [
          `Use the execute tool (Code Mode) once, with code that tries, each in its own try/catch, to: call the read tool on ${join(repo, 'top.txt')}; call the webfetch tool on https://example.com; call the write tool to create ${canary} with the text "probe"; call the shell tool with the command "echo hi". Return what each attempt did.`,
          'Then answer with one line per attempt: WORKED or REFUSED, plus the error text. Nothing else.',
        ].join('\n'),
      )
      console.log(`live permissions execute ${JSON.stringify(executeOnly, null, 2)}`)
      const executeControl = await run(
        { name: 'executor-all', permissions: { rules: [rule('*', 'allow')] } },
        { allowDirectories: [repo] },
        `Use the execute tool (Code Mode) once, with code that calls the read tool on ${join(repo, 'top.txt')} and returns the text. Then answer with the text only.`,
      )
      console.log(`live permissions execute control ${JSON.stringify(executeControl, null, 2)}`)

      const files = {
        top: readFileSync(join(repo, 'top.txt'), 'utf8'),
        newFileExists: existsSync(join(repo, 'new.txt')),
        executeFile: existsSync(canary),
      }
      console.log(`live permissions files ${JSON.stringify(files)}`)
      // Measured 2026-10-28 on 2.0.32 (check route, well under $0.01 for the whole file): a denied tool is not in the
      // model's tool list at all, and a call to it anyway ends in "No tool named … is currently available" without
      // ending the turn. Code Mode's catalog holds MCP, browser and OpenCode session tools, never the built-in ones (not even `read` with
      // everything allowed: the control run), and under this policy it is empty: `execute` reaches no denied tool.
      const ALLOWED = ['glob', 'grep', 'read', 'skill']
      const names = (calls: ToolCall[]) => [...new Set(calls.map((t) => t.tool))].sort()
      // A model may skip a prompted call, so these are per-tool facts: whatever it did call, the allowed tools
      // completed and every other one failed; and it did use the read tool.
      expect(restricted.tools.map((t) => t.tool)).toContain('read')
      expect(restricted.tools.filter((t) => ALLOWED.includes(t.tool)).every((t) => t.status === 'completed')).toBe(true)
      expect(restricted.tools.filter((t) => !ALLOWED.includes(t.tool)).every((t) => t.status === 'error')).toBe(true)
      expect(optIn.tools.find((t) => t.tool === 'webfetch')?.status).toBe('completed')
      const search = optIn.tools.find((t) => t.tool === 'websearch')
      expect(search).toBeDefined() // attempted, not merely absent from the answer
      expect(search?.status).toBe('error')
      expect(search?.reason).toContain('No tool named')
      const lists = (listing: string[], has: string[], lacks: string[]) => {
        for (const tool of has) expect(listing).toContain(tool)
        for (const tool of lacks) expect(listing).not.toContain(tool)
      }
      const DENIED = ['edit', 'write', 'shell', 'webfetch', 'websearch', 'subagent', 'execute']
      lists(listings.baseline, ALLOWED, DENIED)
      lists(listings.withoutGlobGrepSkill, ['read'], ['glob', 'grep', 'skill', ...DENIED])
      lists(listings.withoutRead, ['glob', 'grep', 'skill'], ['read', ...DENIED])
      lists(
        listings.optInEdit,
        [...ALLOWED, 'edit', 'write'],
        ['shell', 'webfetch', 'websearch', 'subagent', 'execute'],
      )
      lists(
        listings.optInWebsearch,
        [...ALLOWED, 'websearch'],
        ['edit', 'write', 'shell', 'webfetch', 'subagent', 'execute'],
      )
      lists(
        listings.optInSubagent,
        [...ALLOWED, 'subagent'],
        ['edit', 'write', 'shell', 'webfetch', 'websearch', 'execute'],
      )
      lists(
        listings.optInExecute,
        [...ALLOWED, 'execute'],
        ['edit', 'write', 'shell', 'webfetch', 'websearch', 'subagent'],
      )
      lists(
        listings.optInShell,
        [...ALLOWED, 'shell'],
        ['edit', 'write', 'webfetch', 'websearch', 'subagent', 'execute'],
      )
      expect(names(executeOnly.tools).filter((t) => ['webfetch', 'write', 'edit', 'shell'].includes(t))).toEqual([])
      expect(files).toEqual({ top: 'TOKEN-TOP-4417\n', newFileExists: false, executeFile: false })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
  900_000,
)

const patch = 'live: PATCH /api/session/{id} swaps a session’s permissions between turns'

test.skipIf(!live)(
  live ? patch : `${patch} (skipped: runs only with AGW_LIVE=1)`,
  async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'och-live-'))
    const server = new OpenCodeServer({ stateDir, livenessIntervalMs: 1_000 })
    const host = new OpenCodeHost({
      server,
      stateDir,
      agents: [{ name: 'patched', route: 'check', agentsMd: AGENTS_MD }],
    })
    const ask =
      'Do not call any tool. List the exact names of every tool available to you, comma separated, in alphabetical order, nothing else.'
    try {
      await server.start()
      const client = createClient(() => server.endpoint())
      const handle = (await host.open({
        runId: 'live',
        stepId: 'patched',
        key: 'live:patched',
        agent: 'patched',
        prompt: '',
      })) as OpenCodeHandle
      const turn = async (id: string) => {
        await client.prompt(handle.sessionId, { id, text: ask })
        for (let calm = 0; calm < 3; ) {
          const [messages, active] = await Promise.all([client.messages(handle.sessionId), client.active()])
          calm = !active.has(handle.sessionId) && messages.at(-1)?.type === 'idle' ? calm + 1 : 0
          await Bun.sleep(300)
        }
        const text = (await client.messages(handle.sessionId))
          .filter((m) => m.type === 'assistant')
          .flatMap((m) => (m.content ?? []).filter((p) => p.type === 'text').map((p) => p.text ?? ''))
        return toolNames(text.at(-1) ?? '')
      }
      const created = await turn('msg_agwp_patch1')
      const wider = sessionPermissions({
        name: 'patched',
        agentsMd: '',
        permissions: { shell: true, rules: [{ action: 'webfetch', resource: '*', effect: 'allow' }] },
      })
      await client.updateSession(handle.sessionId, { permissions: wider })
      const widened = await turn('msg_agwp_patch2')
      const storedWider = (await client.getSession(handle.sessionId))?.permissions
      const narrow = sessionPermissions({ name: 'patched', agentsMd: '' })
      await client.updateSession(handle.sessionId, { permissions: narrow })
      const restored = await turn('msg_agwp_patch3')
      const storedNarrow = (await client.getSession(handle.sessionId))?.permissions
      console.log(`live permissions patch ${JSON.stringify({ created, widened, restored, storedNarrow }, null, 2)}`)
      expect(created).not.toContain('webfetch')
      expect(widened).toContain('webfetch') // the next turn after the PATCH reads the new rules
      expect(widened).toContain('shell')
      expect(restored).not.toContain('webfetch')
      expect(restored).not.toContain('shell')
      expect(storedWider).toEqual(wider)
      expect(storedNarrow).toEqual(narrow) // replaced, not appended
    } finally {
      host.close()
      await server.close({ stop: true })
      rmSync(stateDir, { recursive: true, force: true })
    }
  },
  600_000,
)
