// The plain-text renderer of the agent overview: the line-length cap and trailing newline, colour, narrow terminals,
// the human-queue block and the header suffix. No subprocess, no mocks.

import { describe, expect, test } from 'bun:test'
import { type AgentEnrichment, fitHeader, type RenderTextOptions, renderText } from '../src/fleet/render.ts'
import type { Agent, HumanQueueEntry, Snapshot as AgentsSnapshot } from '../src/fleet/schema.ts'
import { stripAnsi } from '../src/fleet/text.ts'

const HOUR_MS = 60 * 60 * 1000
const NOW = Date.parse('2026-09-06T12:00:00.000Z')

// ── renderText ───────────────────────────────────────────────────────────────────────────────

describe('renderText', () => {
  function snapshot(overrides: Partial<AgentsSnapshot> = {}): AgentsSnapshot {
    return {
      generatedAt: NOW,
      staleAfterHours: 24,
      summary: { needsYou: 0, working: 0, idle: 0, stale: 0, done: 0 },
      projects: [],
      humanQueue: [],
      warnings: [],
      ...overrides,
    }
  }

  test('every line is at most 110 chars, even with a long title', () => {
    const longTitle = 'T'.repeat(400)
    const data = snapshot({
      summary: { needsYou: 1, working: 0, idle: 0, stale: 0, done: 0 },
      projects: [
        {
          name: 'some-project',
          cwd: '/x/some-project',
          git: { branch: 'master', dirty: true, ahead: 0, behind: 0, lastCommit: null },
          agents: [
            {
              id: 's1',
              source: 'factory',
              sessionId: 's1',
              paneId: 'wR:p4',
              workspaceId: 'wR',
              title: longTitle,
              state: 'needs_you',
              herdrStatus: 'blocked',
              claudeStatus: null,
              waitingFor: 'a very long waiting reason '.repeat(5),
              lastPrompt: null,
              lastReply: null,
              lastActivityAt: NOW - 5 * 60_000,
              startedAt: null,
            },
          ],
        },
      ],
    })

    const text = renderText(data)
    for (const line of text.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(110)
    }
  })

  test('an untitled agent renders as (untitled)', () => {
    const data = snapshot({
      projects: [
        {
          name: 'p',
          cwd: '/x/p',
          git: null,
          agents: [
            {
              id: 's1',
              source: 'factory',
              sessionId: 's1',
              paneId: null,
              workspaceId: null,
              title: null,
              state: 'idle',
              herdrStatus: null,
              claudeStatus: 'idle',
              waitingFor: null,
              lastPrompt: null,
              lastReply: null,
              lastActivityAt: null,
              startedAt: null,
            },
          ],
        },
      ],
    })
    expect(renderText(data)).toContain('(untitled)')
  })

  test('header line carries the summary counts and no project lines when there are none', () => {
    const text = renderText(snapshot())
    expect(text).toContain('0 needs_you')
    // One header line plus the trailing newline's empty tail element.
    expect(text.split('\n')).toEqual([expect.stringContaining('0 needs_you'), ''])
  })

  test("output ends with a trailing newline (so it doesn't glue onto the next shell prompt)", () => {
    expect(renderText(snapshot()).endsWith('\n')).toBe(true)
  })
})

// ── renderText — colour (opts.color) ────────────────────────────────────────────────────────

describe('renderText with color', () => {
  function coloredSnapshot(overrides: Partial<AgentsSnapshot> = {}): AgentsSnapshot {
    return {
      generatedAt: NOW,
      staleAfterHours: 24,
      summary: { needsYou: 1, working: 0, idle: 0, stale: 0, done: 0 },
      projects: [
        {
          name: 'some-project',
          cwd: '/x/some-project',
          git: { branch: 'master', dirty: true, ahead: 0, behind: 0, lastCommit: null },
          agents: [
            {
              id: 's1',
              source: 'factory',
              sessionId: 's1',
              paneId: 'wR:p4',
              workspaceId: 'wR',
              title: 'blocked on a question',
              state: 'needs_you',
              herdrStatus: 'blocked',
              claudeStatus: null,
              waitingFor: 'dialog open',
              lastPrompt: null,
              lastReply: null,
              lastActivityAt: NOW - 5 * 60_000,
              startedAt: null,
            },
          ],
        },
      ],
      humanQueue: [],
      warnings: [],
      ...overrides,
    }
  }

  test('plain output is identical with color:false and with no opts at all', () => {
    const data = coloredSnapshot()
    expect(renderText(data, { color: false })).toBe(renderText(data))
  })

  test('a needs_you (answer-equivalent) agent line carries the bold-red SGR', () => {
    const text = renderText(coloredSnapshot(), { color: true })
    const line = text.split('\n').find((l) => l.includes('blocked on a question'))
    expect(line).toBeDefined()
    expect(line).toContain('\x1b[1m\x1b[31m')
  })

  // MUTATION-VERIFIED: dropping the trailing `${RESET}` from a coloured span's line builder
  // (e.g. rendering `${spanColor}${base}` with no reset) turns this red — every line containing
  // an escape byte would no longer end with the reset sequence.
  test('every coloured line resets before the newline', () => {
    const text = renderText(coloredSnapshot(), { color: true })
    for (const line of text.split('\n')) {
      if (line.includes('\x1b[')) {
        expect(line.endsWith('\x1b[0m')).toBe(true)
      }
    }
  })

  test('stripAnsi(coloured) matches the plain render, once the extra summary-bar line is dropped', () => {
    const data = coloredSnapshot()
    const plain = renderText(data)
    const colored = renderText(data, { color: true })
    // Colored mode inserts one extra bar line right after the header (index 1).
    const coloredLines = stripAnsi(colored).split('\n')
    coloredLines.splice(1, 1)
    expect(coloredLines.join('\n')).toBe(plain)
  })

  test('the visible-width clamp still holds when a 200-char waitingFor pushes the line over 110', () => {
    const longWaitingFor = 'w'.repeat(200)
    const data = coloredSnapshot({
      projects: [
        {
          name: 'some-project',
          cwd: '/x/some-project',
          git: { branch: 'master', dirty: false, ahead: 0, behind: 0, lastCommit: null },
          agents: [
            {
              id: 's1',
              source: 'factory',
              sessionId: 's1',
              paneId: 'wR:p4',
              workspaceId: 'wR',
              title: 'some task',
              state: 'needs_you',
              herdrStatus: 'blocked',
              claudeStatus: null,
              waitingFor: longWaitingFor,
              lastPrompt: null,
              lastReply: null,
              lastActivityAt: NOW - 5 * 60_000,
              startedAt: null,
            },
          ],
        },
      ],
    })
    const text = renderText(data, { color: true })
    for (const line of text.split('\n')) {
      // Every visible-clamped line still ends in a reset once truncated.
      expect(stripAnsi(line).length).toBeLessThanOrEqual(110)
      if (line.includes('\x1b[')) expect(line.endsWith('\x1b[0m')).toBe(true)
    }
  })
})

// ── renderText — narrow terminal (opts.cols) ────────────────────────────────────────────────

describe('renderText with cols', () => {
  // Deliberately over-long everywhere a real terminal could wrap: two agents (one blocked with
  // a long waitingFor, one plain), a long title, a long branch/project name, and — via
  // enrichment — a long standing line. Shared by both narrow-width tests below.
  function bigFixture(): { data: AgentsSnapshot; enrichment: Map<string, AgentEnrichment> } {
    const data: AgentsSnapshot = {
      generatedAt: NOW,
      staleAfterHours: 24,
      summary: { needsYou: 1, working: 1, idle: 0, stale: 0, done: 0 },
      warnings: [],
      humanQueue: [],
      projects: [
        {
          name: 'a-fairly-long-project-name-for-testing',
          cwd: '/x/some-project',
          git: {
            branch: 'a-fairly-long-feature-branch-name',
            dirty: true,
            ahead: 0,
            behind: 0,
            lastCommit: null,
          },
          agents: [
            {
              id: 'a1',
              source: 'factory',
              sessionId: 'a1',
              paneId: 'wR:p4',
              workspaceId: 'wR',
              title: 'T'.repeat(200),
              state: 'needs_you',
              herdrStatus: 'blocked',
              claudeStatus: null,
              waitingFor: 'w'.repeat(200),
              lastPrompt: null,
              lastReply: null,
              lastActivityAt: NOW - 5 * 60_000,
              startedAt: null,
            },
            {
              id: 'a2',
              source: 'factory',
              sessionId: 'a2',
              paneId: null,
              workspaceId: null,
              title: 'another task in progress',
              state: 'working',
              herdrStatus: null,
              claudeStatus: 'busy',
              waitingFor: null,
              lastPrompt: null,
              lastReply: null,
              lastActivityAt: NOW - 60_000,
              startedAt: null,
            },
          ],
        },
      ],
    }
    const enrichment = new Map<string, { recommendation: 'answer'; standing: string }>([
      ['a1', { recommendation: 'answer', standing: 's'.repeat(300) }],
    ])
    return { data, enrichment }
  }

  function assertWidthHolds(cols: number) {
    const { data, enrichment } = bigFixture()
    const text = renderText(data, { enrichment, overview: { ageMs: 0 }, color: true, cols })
    const lines = text.split('\n')
    for (const line of lines) {
      expect(stripAnsi(line).length).toBeLessThanOrEqual(cols)
    }
    // The standing line's truncation must still elide with "…", not get chopped mid-ellipsis
    // by the hard clamp — this is what the `standingMax = cols - 8` offset (not just `cols`)
    // exists for.
    const standingLine = lines.find((l) => l.includes('—'))
    expect(standingLine).toBeDefined()
    expect(stripAnsi(standingLine as string).endsWith('…')).toBe(true)
  }

  test("every line's visible width stays within cols=80 on the big fixture", () => {
    assertWidthHolds(80)
  })

  test("every line's visible width stays within cols=60 on the big fixture", () => {
    assertWidthHolds(60)
  })

  test('title is capped at cols-40 (min 20) — a cols=45 title never grows the line', () => {
    const { data, enrichment } = bigFixture()
    const text = renderText(data, { enrichment, overview: { ageMs: 0 }, cols: 45 })
    const agentLine = text.split('\n').find((l) => l.includes('TTTT'))
    expect(agentLine).toBeDefined()
    // MIN_TITLE_CHARS(20) survives as the truncated title's length (incl. the elided "…").
    expect(agentLine).toContain('T'.repeat(19) + '…')
  })

  test('project line drops the agent-count suffix below cols=90', () => {
    const { data, enrichment } = bigFixture()
    const text = renderText(data, { enrichment, overview: { ageMs: 0 }, cols: 80 })
    const projectLine = text.split('\n').find((l) => l.includes('▸'))
    expect(projectLine).toBeDefined()
    expect(projectLine).not.toContain('agents]')
  })

  test('project line keeps the agent-count suffix at cols=90 and above', () => {
    const { data, enrichment } = bigFixture()
    const text = renderText(data, { enrichment, overview: { ageMs: 0 }, cols: 90 })
    const projectLine = text.split('\n').find((l) => l.includes('▸'))
    expect(projectLine).toContain('[2 agents]')
  })

  test('header splits into two lines below cols=100', () => {
    const { data, enrichment } = bigFixture()
    const text = renderText(data, { enrichment, overview: { ageMs: 0 }, cols: 80 })
    const lines = text.split('\n')
    expect(lines[0]).toContain('needs_you')
    expect(lines[0]).not.toContain('overview')
    expect(lines[1]).toContain('overview')
  })

  test('header stays one (unsplit) line once cols is wide enough to hold it whole', () => {
    const { data, enrichment } = bigFixture()
    // Wide enough that the combined counts+timestamp+overview header (~115 chars here) is
    // never truncated — cols=100 alone only guarantees "not split", not "not clamped", since
    // `cols` "replaces the fixed 110 clamp for every line" including the header.
    const text = renderText(data, { enrichment, overview: { ageMs: 0 }, cols: 150 })
    const lines = text.split('\n')
    expect(lines[0]).toContain('needs_you')
    expect(lines[0]).toContain('overview')
    expect(lines.filter((l) => l.includes('overview')).length).toBe(1)
  })

  // MUTATION-VERIFIED: replacing `standingMax = cols - 8` with `cols` (dropping the prefix
  // offset) turns this red — clampVisible's hard cut then lands mid-ellipsis, so the standing
  // line no longer ends with "…".
  test("mutation guard: the standing cap leaves room for the '      — ' prefix", () => {
    assertWidthHolds(80)
    assertWidthHolds(60)
  })

  test('default behaviour (no opts.cols at all) is unaffected by the narrow-width machinery', () => {
    const { data, enrichment } = bigFixture()
    const opts: RenderTextOptions = { enrichment, overview: { ageMs: 0 } }
    const text = renderText(data, opts)
    // Single header line (never split — legacy path), title truncated at the fixed
    // MAX_TITLE_CHARS (48), agent-count suffix kept — all exactly as before `cols` existed.
    const lines = text.split('\n')
    expect(lines[0]).toContain('overview') // not split into two lines
    expect(lines.filter((l) => l.includes('overview')).length).toBe(1)
    expect(text).toContain('[2 agents]')
    // Header stays exempt from the clamp in this path (documented above) — every OTHER line
    // still respects the fixed 110-char cap.
    for (const line of lines.slice(1)) {
      expect(line.length).toBeLessThanOrEqual(110)
    }
  })
})

describe('renderText human-queue block and header suffix', () => {
  const NOW_MS = Date.parse('2026-09-07T10:00:00Z')
  function snap(humanQueue: HumanQueueEntry[]): AgentsSnapshot {
    return {
      generatedAt: NOW_MS,
      staleAfterHours: 24,
      summary: { needsYou: 0, working: 0, idle: 0, stale: 0, done: 0 },
      projects: [],
      humanQueue,
      warnings: [],
    }
  }
  const entry: HumanQueueEntry = {
    id: '20260907T080000-1',
    askedAt: '2026-09-07T08:00:00Z',
    question: 'Push the tailnet ACL:\n  new grant tag:vps → tag:devhost',
    cmd: 'make tailscale-acl-push',
  }

  test('an empty queue renders no block — byte-identical to before the field existed', () => {
    const text = renderText(snap([]))
    expect(text).not.toContain('needs you')
  })

  test("a pending request renders a 'needs you' block right under the header, newlines collapsed", () => {
    const lines = renderText(snap([entry])).split('\n')
    expect(lines[1]).toBe('needs you (human queue: 1)')
    expect(lines[2]).toBe('  ! Push the tailnet ACL: new grant tag:vps → tag:devhost  · 2h  [cmd]')
  })

  test('the block stays within the width budget and keeps the age + [cmd] marker', () => {
    const long = { ...entry, question: 'q'.repeat(300) }
    const line =
      renderText(snap([long]), { cols: 80 })
        .split('\n')
        .find((l) => l.startsWith('  ! ')) ?? ''
    expect(line.length).toBeLessThanOrEqual(80)
    expect(line.endsWith('  · 2h  [cmd]')).toBe(true)
  })

  test('the block is rendered from the snapshot alone — no overview enrichment needed', () => {
    const text = renderText(snap([entry]), { enrichment: new Map(), overview: null, cols: 110 })
    expect(text).toContain('needs you (human queue: 1)')
    expect(text.split('\n')[0]).toContain('overview none')
  })
})

describe('fitHeader', () => {
  const counts = 'agents: 1 needs_you · 2 working · 0 idle · 0 stale · 0 done'
  const iso = '2026-09-07T10:15:53.123Z'
  const suffix = '  · overview 2m'

  test('fits as-is when the full header is within the budget', () => {
    expect(fitHeader(counts, iso, suffix, 200)).toBe(`${counts}  (${iso})${suffix}`)
  })

  test('when the full header overflows the date is dropped, the overview suffix survives intact', () => {
    const out = fitHeader(counts, iso, suffix, 100)
    expect(out.length).toBeLessThanOrEqual(100)
    expect(out.endsWith(suffix)).toBe(true)
    expect(out).toContain('(10:15:53.123Z)')
    expect(out.startsWith(counts)).toBe(true)
  })

  test('when even the compact form overflows, the counts are truncated, never the suffix', () => {
    const out = fitHeader(counts, iso, suffix, 70)
    expect(out.length).toBeLessThanOrEqual(70)
    expect(out.endsWith(suffix)).toBe(true)
    expect(out).toContain('…')
  })

  test("MUTATION GUARD: the default-cols overview.txt header keeps '· overview' (the regression)", () => {
    const text = renderText(
      {
        generatedAt: Date.parse(iso),
        staleAfterHours: 24,
        summary: { needsYou: 1, working: 2, idle: 0, stale: 0, done: 0 },
        projects: [],
        humanQueue: [],
        warnings: [],
      },
      { enrichment: new Map(), overview: { ageMs: 120_000 }, cols: 110 },
    )
    const header = text.split('\n')[0] ?? ''
    expect(header.length).toBeLessThanOrEqual(110)
    expect(header).toContain('· overview 2m')
  })
})
