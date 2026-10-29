// The legacy arm (L) of the otel eval (docs/research/2026-10-29-wave7-ports.md §otel): agent-gateway's MCP `otel` tool,
// once per case, scored by the same scorer as the new arm. Reads agent-gateway's checkout and nothing else of it: its
// MCP server runs as a stdio child (`bun run server/mcp.ts`) and is called with its own SDK client.
//
//   bun scripts/eval-legacy/otel.ts [--ids a,b] [--limit N]
//
// Environment: AGW_EVAL_DIR (cases; results go to <evalDir>/otel/legacy-runs.jsonl, mode 0600), AGW_LEGACY_DIR
// (agent-gateway's checkout, default ~/SourceRoot/agent-gateway), AGW_BIN (the `agw` CLI the judge runs through),
// AGW_USAGE_TRACKER_DIR (default ~/.local/share/usage-tracker). Prints counts only: cases and results are private.
import { appendFileSync, closeSync, openSync, readSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { casesPath } from '../../packages/eval/src/index.ts'
import type { Json } from '../../packages/runtime/src/json.ts'
import type { ScoreJudge } from '../../packages/runtime/src/types.ts'
import { readSuite } from '../../packages/host/src/workflows/eval/suites.ts'
import { OtelInput } from '../../packages/host/src/workflows/otel/schema.ts'
import { otelScorer } from '../../packages/host/src/workflows/otel/scorer.ts'

type ToolResult = { isError?: boolean; structuredContent?: unknown; content?: { type: string; text?: string }[] }
type McpClient = {
  connect(transport: unknown): Promise<void>
  callTool(
    call: { name: string; arguments: Record<string, unknown> },
    schema?: undefined,
    options?: { timeout?: number; resetTimeoutOnProgress?: boolean },
  ): Promise<ToolResult>
  close(): Promise<void>
}
type Sdk = {
  Client: new (info: { name: string; version: string }) => McpClient
  StdioClientTransport: new (options: {
    command: string
    args: string[]
    cwd: string
    env: Record<string, string>
    stderr: 'ignore'
  }) => unknown
}

const env = process.env
const legacyDir = env.AGW_LEGACY_DIR ?? join(homedir(), 'SourceRoot', 'agent-gateway')
const agw = env.AGW_BIN ?? 'agw'
const sessionsLog = join(env.AGW_USAGE_TRACKER_DIR ?? join(homedir(), '.local', 'share', 'usage-tracker'), 'agent-gateway-sessions.jsonl')
/** The call may run as long as the worker needs (no wall-clock ceiling on an agent); this is a hang guard. */
const CALL_TIMEOUT_MS = 60 * 60_000

async function loadSdk(): Promise<Sdk> {
  const root = join(legacyDir, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm')
  const client = (await import(join(root, 'client', 'index.js'))) as Pick<Sdk, 'Client'>
  const stdio = (await import(join(root, 'client', 'stdio.js'))) as Pick<Sdk, 'StdioClientTransport'>
  return { Client: client.Client, StdioClientTransport: stdio.StdioClientTransport }
}

/** The scorer's judge: `decide` through the agw CLI, a recorded eval run like any other. */
const judge: ScoreJudge = async (capability, input) => {
  if (capability !== 'decide') throw new Error(`the legacy runner judges with decide only, not ${capability}`)
  const { state, questions } = input as { state: string; questions: Json }
  const proc = Bun.spawn([agw, 'decide', '--state', state, '--questions', JSON.stringify(questions), '--format', 'json'], {
    env: { ...env, AGW_PURPOSE: 'eval' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  if (code !== 0) throw new Error(`agw decide exited ${code}: ${stderr.slice(0, 300)}`)
  return JSON.parse(stdout) as Json
}

function outputOf(result: ToolResult): { output: Json | null; error?: string } {
  const text = result.content?.find((c) => c.type === 'text')?.text
  if (result.isError) return { output: null, error: (text ?? 'the tool answered an error').slice(0, 300) }
  if (result.structuredContent !== undefined) return { output: result.structuredContent as Json }
  try {
    return { output: JSON.parse(text ?? '') as Json }
  } catch {
    return { output: null, error: 'the tool answered no JSON' }
  }
}

/** The tail of the sessions log: a long file is read from its end, whole lines only. */
function tailLines(path: string, bytes: number): string[] {
  const size = statSync(path).size
  const start = Math.max(0, size - bytes)
  const fd = openSync(path, 'r')
  try {
    const buffer = Buffer.alloc(size - start)
    readSync(fd, buffer, 0, buffer.length, start)
    const lines = buffer.toString('utf8').split('\n')
    return start > 0 ? lines.slice(1) : lines
  } finally {
    closeSync(fd)
  }
}

/** The worker session the call ran: agent-gateway's own record of its cost (the tool's answer carries none). */
function sessionCost(startedMs: number, endedMs: number): number | null {
  const slack = 5_000
  let best: { cost: number; gap: number } | null = null
  try {
    for (const line of tailLines(sessionsLog, 2_000_000)) {
      if (!line.includes('"tool":"otel"')) continue
      const row = JSON.parse(line) as { tsStart?: string; tsEnd?: string; costUsd?: number }
      const a = Date.parse(row.tsStart ?? '')
      const b = Date.parse(row.tsEnd ?? '')
      if (typeof row.costUsd !== 'number' || !(a >= startedMs - slack) || !(b <= endedMs + slack)) continue
      const gap = Math.abs(b - endedMs)
      if (!best || gap < best.gap) best = { cost: row.costUsd, gap }
    }
  } catch {
    return null
  }
  return best?.cost ?? null
}

function parseArgs(argv: string[]) {
  const value = (flag: string) => {
    const at = argv.indexOf(flag)
    return at === -1 ? undefined : argv[at + 1]
  }
  const limit = value('--limit')
  return { ids: value('--ids')?.split(','), limit: limit ? Number(limit) : undefined }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  let cases = readSuite('otel', env)
  if (args.ids) cases = cases.filter((c) => args.ids?.includes(c.id))
  if (args.limit) cases = cases.slice(0, args.limit)
  if (cases.length === 0) throw new Error(`no otel cases in ${casesPath('otel', env)}`)
  const sdk = await loadSdk()
  const out = join(casesPath('otel', env), '..', 'legacy-runs.jsonl')
  writeFileSync(out, '', { flag: 'a', mode: 0o600 })

  let scored = 0
  let failed = 0
  for (const c of cases) {
    const input = OtelInput.parse(c.input('', {}))
    // The legacy tool takes no window: it goes into the investigation text, as a caller of /otel writes it.
    const window = input.since?.includes('/') ? `Time window: ${input.since.replace('/', ' to ')} (UTC).` : input.since ? `Time window: the last ${input.since}.` : ''
    const client = new sdk.Client({ name: 'agw-eval-legacy', version: '1' })
    await client.connect(
      new sdk.StdioClientTransport({
        command: 'bun',
        args: ['run', 'server/mcp.ts'],
        cwd: legacyDir,
        env: { ...env } as Record<string, string>,
        stderr: 'ignore',
      }),
    )
    const startedMs = Date.now()
    let answer: { output: Json | null; error?: string }
    try {
      const result = await client.callTool(
        { name: 'otel', arguments: { investigation: [input.investigation, window].filter(Boolean).join('\n\n'), environment: input.env } },
        undefined,
        { timeout: CALL_TIMEOUT_MS, resetTimeoutOnProgress: true },
      )
      answer = outputOf(result)
    } catch (error) {
      answer = { output: null, error: (error instanceof Error ? error.message : String(error)).slice(0, 300) }
    } finally {
      await client.close().catch(() => {})
    }
    const endedMs = Date.now()
    const reference = otelScorer.reference?.parse(c.reference)
    const verdict = await otelScorer.score(input, answer.output, {
      source: 'regression',
      judge,
      signal: new AbortController().signal,
      ...(reference ? { reference } : {}),
    })
    appendFileSync(
      out,
      `${JSON.stringify({
        id: c.id,
        arm: 'legacy',
        wallMs: endedMs - startedMs,
        costUsd: sessionCost(startedMs, endedMs),
        ...(answer.error ? { error: answer.error } : {}),
        output: answer.output,
        scores: verdict.scores,
        pass: verdict.pass,
      })}\n`,
    )
    if (answer.output === null) failed++
    else scored++
  }
  console.log(`otel legacy arm: ${cases.length} case(s), ${scored} answered, ${failed} failed; rows appended to the eval dir`)
}

await main()
