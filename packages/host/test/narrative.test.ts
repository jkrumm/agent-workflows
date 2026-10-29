import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCapabilities, createRegistry } from '@agent-workflows/capabilities'
import { fakeTransports } from '@agent-workflows/capabilities/testing'
import { resolveRoute } from '@agent-workflows/routes'
import {
  BOOTSTRAP_COMMIT_LIMIT,
  BOOTSTRAP_DAYS,
  BOOTSTRAP_SESSION_LIMIT,
  SINCE_SESSION_LIMIT,
  COMMITS_MAX_BYTES,
  encodeProjectDir,
  type GatherPorts,
  gatherFacts,
  type SessionFile,
  SESSIONS_MAX_BYTES,
} from '../src/workflows/narrative/gather.ts'
import { createNarrative } from '../src/workflows/narrative/index.ts'
import { NarrativeInput, NarrativeOutput } from '../src/workflows/narrative/schema.ts'
import type { HostWorkflow } from '../src/operations.ts'
import { freshSchema, testRuntime } from '../../runtime/test/support/pg.ts'

const dir = mkdtempSync(join(tmpdir(), 'agw-narrative-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const VOICE = join(dir, 'voice.md')
writeFileSync(VOICE, 'SECRET-VOICE-RULES: write plainly.')

const NOW = new Date('2026-10-29T10:00:00.000Z')
const FLOOR = new Date(NOW.getTime() - BOOTSTRAP_DAYS * 24 * 60 * 60 * 1000).toISOString()
const CWD = '/work/weatherorb'
const SESSION_DIR = join('/projects', encodeProjectDir(CWD))

// ── Fake ports ──────────────────────────────────────────────────────────────────────────────

const jsonl = (...records: Record<string, unknown>[]) => records.map((r) => JSON.stringify(r)).join('\n')
const longBlock = (tag: string) => ({
  type: 'assistant',
  message: { content: [{ type: 'text', text: `${tag} ${'a'.repeat(210)}` }] },
})
const transcript = (title: string) => jsonl({ type: 'ai-title', aiTitle: title }, longBlock(title))
const file = (name: string, mtimeMs: number, size = 8 * 1024): SessionFile => ({ file: `${name}.jsonl`, size, mtimeMs })

function fakePorts(options: { commits?: string; files?: SessionFile[]; tails?: Record<string, string> } = {}) {
  const gitCalls: string[][] = []
  const dirs: string[] = []
  const reads: string[] = []
  const tails = options.tails ?? {}
  const ports: GatherPorts = {
    projectsDir: '/projects',
    async git(_cwd, args) {
      gitCalls.push(args)
      return options.commits ?? ''
    },
    async sessionFiles(d) {
      dirs.push(d)
      return options.files ?? []
    },
    async readTail(path) {
      reads.push(path.slice(path.lastIndexOf('/') + 1))
      const tail = tails[path.slice(path.lastIndexOf('/') + 1)]
      if (tail === undefined) throw new Error('ENOENT')
      return tail
    },
  }
  return { ports, gitCalls, dirs, reads }
}

const commit = (n: number, body = '') =>
  `c${n.toString().padStart(6, '0')} 2026-10-0${(n % 9) + 1}T00:00:00+00:00 feat: change ${n}\n${body}`
const gitOutput = (entries: string[]) => entries.map((e) => `${e}\x1e`).join('\n')

// ── Gathering ───────────────────────────────────────────────────────────────────────────────

describe('gatherFacts: the bounds are legacy’s', () => {
  test('bootstrap: the last 120 commits or 180 days, whichever is smaller; the floor is the effective cutoff', async () => {
    const f = fakePorts({ commits: gitOutput([commit(1), commit(2)]) })
    const out = await gatherFacts(f.ports, { cwd: CWD, since: null, now: NOW.getTime() })
    expect(f.gitCalls[0]).toEqual([
      'log',
      '--no-merges',
      '--pretty=format:%h %cI %s%n%b\x1e',
      `--since=${FLOOR}`,
      '-n',
      String(BOOTSTRAP_COMMIT_LIMIT),
    ])
    expect(out.sinceUsed).toBe(FLOOR)
    expect(out.commits.count).toBe(2)
  })

  test('with a cutoff: commits since it, no count limit', async () => {
    const f = fakePorts()
    const out = await gatherFacts(f.ports, { cwd: CWD, since: '2026-10-01T00:00:00.000Z', now: NOW.getTime() })
    expect(f.gitCalls[0]).toContain('--since=2026-10-01T00:00:00.000Z')
    expect(f.gitCalls[0]).not.toContain('-n')
    expect(out.sinceUsed).toBe('2026-10-01T00:00:00.000Z')
  })

  test('commits are cut at 30 KB, dropping the oldest, and counted after the cut', async () => {
    const entries = Array.from({ length: 100 }, (_, i) => commit(i, 'x'.repeat(380)))
    const f = fakePorts({ commits: gitOutput(entries) })
    const out = await gatherFacts(f.ports, { cwd: CWD, since: null, now: NOW.getTime() })
    const bytes = Buffer.byteLength(out.commits.text)
    expect(out.commits.count).toBeGreaterThan(0)
    expect(out.commits.count).toBeLessThan(100)
    expect(bytes).toBeLessThanOrEqual(COMMITS_MAX_BYTES)
    expect(out.commits.text).toContain('c000000')
    expect(out.commits.text).not.toContain('c000099')
  })

  test('a failing git (no repo) gathers no commits', async () => {
    const f = fakePorts({ commits: '' })
    expect((await gatherFacts(f.ports, { cwd: CWD, since: null, now: NOW.getTime() })).commits).toEqual({
      text: '',
      count: 0,
    })
  })

  test('sessions come from the encoded project directory, newest first, with their title and closing summaries', async () => {
    const f = fakePorts({
      files: [file('old', 1_000), file('new', 2_000)],
      tails: { 'old.jsonl': transcript('old work'), 'new.jsonl': transcript('new work') },
    })
    const out = await gatherFacts(f.ports, { cwd: CWD, since: null, now: NOW.getTime() })
    expect(f.dirs).toEqual([SESSION_DIR])
    expect(SESSION_DIR).toBe('/projects/-work-weatherorb')
    expect(out.sessions.count).toBe(2)
    expect(out.sessions.text.indexOf('ai-title: new work')).toBeLessThan(
      out.sessions.text.indexOf('ai-title: old work'),
    )
    expect(out.sessions.text).toContain('## Session new (1970-01-01T00:00:02.000Z)')
  })

  test('files under 4 KB are skipped outright', async () => {
    const f = fakePorts({
      files: [file('tiny', 1, 4 * 1024 - 1), file('ok', 2)],
      tails: { 'tiny.jsonl': transcript('tiny'), 'ok.jsonl': transcript('ok') },
    })
    const out = await gatherFacts(f.ports, { cwd: CWD, since: null, now: NOW.getTime() })
    expect(out.sessions.text).toContain('ai-title: ok')
    expect(out.sessions.text).not.toContain('ai-title: tiny')
  })

  test('bootstrap takes the newest 12 with no date filter; a cutoff filters by mtime instead', async () => {
    const files = Array.from({ length: 15 }, (_, i) => file(`s${i}`, 1_000 + i))
    const tails = Object.fromEntries(files.map((s) => [s.file, transcript(s.file)]))
    const boot = await gatherFacts(fakePorts({ files, tails }).ports, { cwd: CWD, since: null, now: NOW.getTime() })
    expect(boot.sessions.count).toBe(BOOTSTRAP_SESSION_LIMIT)
    expect(boot.sessions.text).toContain('s14.jsonl')
    expect(boot.sessions.text).not.toContain('ai-title: s2.jsonl')
    const since = new Date(1_010).toISOString()
    const after = await gatherFacts(fakePorts({ files, tails }).ports, { cwd: CWD, since, now: NOW.getTime() })
    // Strictly after the cutoff, and no count limit.
    expect(after.sessions.count).toBe(4)
  })

  test('with a cutoff, only the newest 24 transcripts are read, however many changed since', async () => {
    const files = Array.from({ length: 300 }, (_, i) => file(`s${i}`, 2_000_000 + i))
    const tails = Object.fromEntries(files.map((f) => [f.file, jsonl({ type: 'assistant', message: { content: [] } })]))
    const f = fakePorts({ files, tails })
    await gatherFacts(f.ports, { cwd: CWD, since: new Date(1_000).toISOString(), now: NOW.getTime() })
    // Nothing yields prose, so nothing stops the loop but the cap.
    expect(f.reads).toHaveLength(SINCE_SESSION_LIMIT)
    expect(f.reads[0]).toBe('s299.jsonl')
  })

  test('a transcript with no title and no long assistant block is dropped without consuming budget', async () => {
    const f = fakePorts({
      files: [file('quiet', 2), file('loud', 1)],
      tails: {
        'quiet.jsonl': jsonl({ type: 'assistant', message: { content: [{ type: 'text', text: 'short' }] } }),
        'loud.jsonl': transcript('loud'),
      },
    })
    const out = await gatherFacts(f.ports, { cwd: CWD, since: null, now: NOW.getTime() })
    expect(out.sessions.count).toBe(1)
    expect(out.sessions.text).toContain('ai-title: loud')
  })

  test('an unreadable transcript is an empty one, never a failure', async () => {
    const f = fakePorts({ files: [file('gone', 2), file('ok', 1)], tails: { 'ok.jsonl': transcript('ok') } })
    const out = await gatherFacts(f.ports, { cwd: CWD, since: null, now: NOW.getTime() })
    expect(out.sessions.count).toBe(1)
  })

  test('sessions are cut at 40 KB', async () => {
    const big = (tag: string) =>
      jsonl(
        { type: 'ai-title', aiTitle: tag },
        ...Array.from({ length: 3 }, () => ({
          type: 'assistant',
          message: { content: [{ type: 'text', text: `${tag} ${'b'.repeat(5_000)}` }] },
        })),
      )
    const files = Array.from({ length: 12 }, (_, i) => file(`s${i}`, 1_000 + i))
    const tails = Object.fromEntries(files.map((s) => [s.file, big(s.file)]))
    const out = await gatherFacts(fakePorts({ files, tails }).ports, { cwd: CWD, since: null, now: NOW.getTime() })
    expect(out.sessions.count).toBeGreaterThan(0)
    expect(out.sessions.count).toBeLessThan(12)
    expect(Buffer.byteLength(out.sessions.text)).toBeLessThanOrEqual(SESSIONS_MAX_BYTES)
  })
})

// ── The workflow ────────────────────────────────────────────────────────────────────────────

const REVIEW = {
  scores: {
    structure: 4,
    no_repetition: 4,
    concision: 4,
    precision: 4,
    clarity: 4,
    visual_fit: 4,
    naturalness: 4,
    engagement: 4,
  },
  notes: [],
  visualSuggestions: [],
}
const SECTIONS = {
  whatItIs: 'A weather service for [[surf-spots|surf spots]].',
  whereItStands: ['Live on the VPS.', 'Ingests two providers.'],
  howItGotHere: [{ date: '2026-03-10', text: 'Added a second provider for redundancy.' }],
  openQuestions: ['Should a third provider be added?'],
}
const CHANGED = {
  changed: true,
  reason: 'a real behavior shift',
  summary: 'Second provider added.',
  sections: SECTIONS,
}

/** The page body the writer is shown, with one phrase reworded: a rewrite the gate keeps. */
const polishedBody = (prompt: string) => {
  const draft = /<<<DRAFT_([0-9a-f]{32})_BEGIN>>>\n([\s\S]*?)\n<<<DRAFT_\1_END>>>/.exec(prompt)?.[2] ?? ''
  return draft.replace('surf spots.', 'surf spots, polished.')
}

type Script = Parameters<typeof fakeTransports>[0]

function setup(
  options: {
    script?: Script
    ports?: GatherPorts
    env?: Record<string, string>
    /** The reviewer call waits for this, after saying it has arrived. */
    hold?: { entered: () => void; released: Promise<void> }
  } = {},
) {
  const env = options.env ?? { AGW_VOICE_PATH: VOICE }
  const transports = fakeTransports({
    openai: [{ text: JSON.stringify(REVIEW), cost: 0.002 }],
    // The composer sends no system prompt; the polish writer always does.
    anthropic: [
      (request) =>
        request.system
          ? { text: polishedBody(request.prompt), cost: 0.05 }
          : { text: JSON.stringify(CHANGED), cost: 0.001 },
    ],
    ...options.script,
  })
  const real = createRegistry(createCapabilities({ transports, env }))
  const registry = options.hold
    ? ({
        call: async (id: string, input: object, callOptions: object) => {
          if (id === 'prose.critique') {
            options.hold?.entered()
            await options.hold?.released
          }
          return (real.call as (...args: unknown[]) => Promise<unknown>)(id, input, callOptions)
        },
      } as unknown as typeof real)
    : real
  const ports =
    options.ports ??
    fakePorts({
      commits: gitOutput([commit(1)]),
      files: [file('s1', 1_000)],
      tails: { 's1.jsonl': transcript('second provider') },
    }).ports
  const [narrative, polish] = createNarrative({ registry, gather: ports, now: () => NOW, env }) as [
    HostWorkflow,
    HostWorkflow,
  ]
  const composed = () => transports.chatCalls.filter((c) => c.wire === 'anthropic' && !c.request.system)
  const writes = () => transports.chatCalls.filter((c) => c.wire === 'anthropic' && c.request.system)
  const reviews = () => transports.chatCalls.filter((c) => c.wire === 'openai')
  return { transports, narrative, polish, composed, writes, reviews }
}

const db = freshSchema('narrative')
async function run(w: ReturnType<typeof setup>, input: Record<string, unknown>) {
  const rt = testRuntime({ schema: db.schema, workflows: [w.narrative.workflow, w.polish.workflow] })
  await rt.open()
  try {
    const { runId } = await rt.start(w.narrative.workflow, input, { purpose: 'build' })
    return await rt.wait(runId)
  } finally {
    await rt.close()
  }
}
const output = (result: Awaited<ReturnType<typeof run>>) => {
  expect(result.status).toBe('done')
  return NarrativeOutput.parse(result.output)
}
const INPUT = { cwd: CWD, project: 'weatherorb', previousPage: null, since: null }

describe('narrative', () => {
  test('the input: previousPage and since default to null, polish to true; unknown fields (a model override) are refused', () => {
    expect(NarrativeInput.parse({ cwd: CWD, project: 'p' })).toEqual({
      cwd: CWD,
      project: 'p',
      previousPage: null,
      since: null,
      polish: true,
    })
    expect(NarrativeInput.parse({ ...INPUT, polish: false }).polish).toBe(false)
    expect(NarrativeInput.safeParse({ ...INPUT, model: 'anything' }).success).toBe(false)
  })

  test('since must be an ISO datetime (an unparseable one would drop every session silently), cwd is bounded', () => {
    for (const since of ['yesterday', '2026-10-01', 'NaN', '']) {
      expect(NarrativeInput.safeParse({ ...INPUT, since }).success).toBe(false)
    }
    for (const since of ['2026-10-01T00:00:00Z', '2026-10-01T00:00:00.000Z', '2026-10-01T02:00:00+02:00']) {
      expect(NarrativeInput.safeParse({ ...INPUT, since }).success).toBe(true)
    }
    expect(NarrativeInput.safeParse({ ...INPUT, cwd: `/${'a'.repeat(1_000)}` }).success).toBe(false)
    expect(NarrativeInput.safeParse({ ...INPUT, cwd: `/${'a'.repeat(999)}` }).success).toBe(true)
  })

  test('no new commits or sessions: unchanged, no model call, the route’s model', async () => {
    const w = setup({ ports: fakePorts().ports })
    const out = output(await run(w, INPUT))
    expect(out).toEqual({
      project: 'weatherorb',
      changed: false,
      reason: 'no new commits or sessions',
      summary: null,
      page: null,
      sections: null,
      inputs: { commits: 0, sessions: 0, sinceUsed: FLOOR },
      model: resolveRoute('narrative', {}).model,
    })
    expect(w.transports.chatCalls).toHaveLength(0)
  })

  test('a changed page: gathered facts, clamped and link-free sections, the polished body under the verbatim frontmatter', async () => {
    const w = setup()
    const out = output(await run(w, INPUT))
    expect(out.changed).toBe(true)
    expect(out.reason).toBe('a real behavior shift')
    expect(out.summary).toBe('Second provider added.')
    expect(out.inputs).toEqual({ commits: 1, sessions: 1, sinceUsed: FLOOR })
    expect(out.model).toBe(resolveRoute('narrative', {}).model)
    // The structured data is the composer's, link-free, and never rewritten by the polish.
    expect(out.sections?.whatItIs).toBe('A weather service for surf spots.')
    expect(out.prose).toEqual({ status: 'polished', kept: 'rewrite', costUsd: expect.closeTo(0.052, 6) })
    expect(out.page).toStartWith('---\ntitle: "weatherorb"\ntype: project-narrative\n')
    expect(out.page).toContain('timestamp: 2026-10-29')
    expect(out.page).toContain('revised_from: "bootstrap"')
    expect(out.page).toContain('A weather service for surf spots, polished.')
    expect(out.page).toContain('- **2026-03-10** — Added a second provider for redundancy.')
    // The composer saw the commits and the session excerpt as fenced data; the polish writer never saw the frontmatter.
    const prompt = w.composed()[0]?.request.prompt ?? ''
    expect(prompt).toMatch(/<<<NARRATIVE_[0-9a-f]{32}_BEGIN>>>/)
    expect(prompt).toContain('feat: change 1')
    expect(prompt).toContain('ai-title: second provider')
    expect(w.writes()[0]?.request.prompt).not.toContain('generated_by')
    expect(w.writes()[0]?.request.prompt).toContain("Keep the page's headings verbatim and in this order")
  })

  test('the polish reviews the body as a vault page that builds up to its verdict', async () => {
    const w = setup()
    await run(w, INPUT)
    const review = w.reviews()[0]?.request.prompt ?? ''
    expect(review).toContain('Medium: a page in a personal Obsidian vault.')
    expect(review).toContain('verdict_first does not apply')
    expect(review).toContain('# weatherorb')
    expect(review).not.toContain('generated_by')
  })

  test('the composer says nothing changed: unchanged with its reason, no polish', async () => {
    const w = setup({
      script: {
        anthropic: [{ text: JSON.stringify({ changed: false, reason: 'only chores', summary: null, sections: null }) }],
      },
    })
    const out = output(await run(w, INPUT))
    expect(out).toMatchObject({ changed: false, reason: 'only chores', summary: null, page: null, sections: null })
    expect(out.prose).toBeUndefined()
    expect(w.reviews()).toHaveLength(0)
    expect(w.writes()).toHaveLength(0)
  })

  test('polish:false returns the page as rendered and runs no review or writer', async () => {
    const w = setup()
    const out = output(await run(w, { ...INPUT, polish: false }))
    expect(out.changed).toBe(true)
    expect(out.prose).toBeUndefined()
    expect(out.page).toContain('A weather service for surf spots.')
    expect(w.reviews()).toHaveLength(0)
    expect(w.writes()).toHaveLength(0)
  })

  test('a rewrite the keep gate refuses: the original page byte for byte, declined with the gate’s reason', async () => {
    const w = setup({
      script: {
        anthropic: [
          (request) =>
            request.system
              ? { text: `${polishedBody(request.prompt)}\n\nSee https://example.com/invented.`, cost: 0.05 }
              : { text: JSON.stringify(CHANGED) },
        ],
      },
    })
    const out = output(await run(w, INPUT))
    expect(out.prose?.status).toBe('declined')
    expect(out.prose?.kept).toBe('original')
    expect(out.prose?.keptReason).toContain('rewrite added the URL')
    expect(out.page).toContain('A weather service for surf spots.\n')
    expect(out.page).not.toContain('polished')
  })

  test.each([
    ['renamed', (b: string) => b.replace('## Where it stands', '## Status')],
    ['dropped', (b: string) => b.replace('## Where it stands\n', '')],
    ['added', (b: string) => b.replace('## Open questions', '## Open questions\n\n## Extra')],
  ])('a rewrite that changes the headings (%s) is declined with the original page', async (_name, change) => {
    const w = setup({
      script: {
        anthropic: [
          (request) =>
            request.system ? { text: change(polishedBody(request.prompt)) } : { text: JSON.stringify(CHANGED) },
        ],
      },
    })
    const out = output(await run(w, INPUT))
    expect(out.prose?.status).toBe('declined')
    expect(out.prose?.keptReason).toBe('rewrite changed the page headings')
    expect(out.page).not.toContain('polished')
  })

  test('a failing polish degrades to the unpolished page and never fails the run', async () => {
    const w = setup({ script: { openai: [new Error('reviewer exploded')] } })
    const result = await run(w, INPUT)
    expect(result.status).toBe('done')
    const out = NarrativeOutput.parse(result.output)
    expect(out.changed).toBe(true)
    expect(out.prose).toEqual({
      status: 'errored',
      kept: 'original',
      // The child's own error, naming the step that failed.
      keptReason: expect.stringMatching(/^prose failed: step "review" failed \(error\): /),
      costUsd: null,
    })
    expect(out.page).toContain('A weather service for surf spots.')
  })

  test('a missing voice guide fails the polish, not the page: the composer needs none', async () => {
    const w = setup({ env: { AGW_VOICE_PATH: join(dir, 'missing.md') } })
    const out = output(await run(w, INPUT))
    expect(out.changed).toBe(true)
    expect(out.prose?.status).toBe('errored')
    expect(out.prose?.keptReason).toContain('AGW_VOICE_PATH')
    expect(w.reviews()).toHaveLength(0)
  })

  test('a cancelled parent ends cancelled, not done with an unpolished page', async () => {
    let enter = () => {}
    let release = () => {}
    const entered = new Promise<void>((resolve) => {
      enter = resolve
    })
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    const w = setup({ hold: { entered: () => enter(), released } })
    const rt = testRuntime({ schema: db.schema, workflows: [w.narrative.workflow, w.polish.workflow] })
    await rt.open()
    try {
      const { runId } = await rt.start(w.narrative.workflow, INPUT, { purpose: 'build' })
      await entered
      await rt.cancel(runId)
      release()
      const result = await rt.wait(runId)
      expect(result.status).toBe('cancelled')
      expect(w.writes()).toHaveLength(0)
    } finally {
      release()
      await rt.close()
    }
  })

  test('the composer’s answer is rejected twice: the run fails, as the legacy job threw', async () => {
    const w = setup({ script: { anthropic: [{ text: 'All done, nothing to report!' }] } })
    const result = await run(w, INPUT)
    expect(result.status).toBe('failed')
    expect(w.composed()).toHaveLength(2)
    expect(w.reviews()).toHaveLength(0)
  })

  test('the composer’s transport failure fails the run', async () => {
    const w = setup({ script: { anthropic: [new Error('connection reset')] } })
    expect((await run(w, INPUT)).status).toBe('failed')
  })

  test('an existing page and a cutoff go into the prompt', async () => {
    const w = setup()
    await run(w, { ...INPUT, previousPage: '# weatherorb\n\nExisting page body.', since: '2026-10-01T00:00:00.000Z' })
    const prompt = w.composed()[0]?.request.prompt ?? ''
    expect(prompt).toContain('Existing page body.')
    expect(prompt).toContain('Revision window: since 2026-10-01T00:00:00.000Z')
  })

  test('sections over their caps are clamped in code, whatever the composer sent', async () => {
    const long = { ...SECTIONS, whereItStands: Array.from({ length: 8 }, (_, i) => `item ${i} ${'y'.repeat(200)}`) }
    const w = setup({ script: { anthropic: [{ text: JSON.stringify({ ...CHANGED, sections: long }) }] } })
    const out = output(await run(w, { ...INPUT, polish: false }))
    expect(out.sections?.whereItStands).toHaveLength(5)
    for (const s of out.sections?.whereItStands ?? []) expect(s.length).toBeLessThanOrEqual(160)
  })
})
