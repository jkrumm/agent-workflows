import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { iuFromEnv } from '@agent-workflows/opencode-host'
import { fallbackRoute, isBalanceFailure, type ResolvedRoute, resolveRoute } from '@agent-workflows/routes'
import { defineWorkflow, type StepScope, type Usage } from '@agent-workflows/runtime'
import { z } from 'zod'
import type { HostWorkflow } from '../../operations.ts'
import { killTree } from './exec.ts'
import type { ReviewPorts } from './git.ts'
import { escapeName } from './util.ts'

// OpenCodeReview (`ocr`, alibaba/open-code-review): one more review input, never a gate. Cross-file consistency,
// config drift and line-anchored findings, on diffs the router judges deep. It is expensive (1.5-3M tokens a run,
// mostly cache reads) and optional, so it is its own workflow: the wallet gate refuses it at admission while IU spend is
// over its cap or before the pause date (concept §4, N8), and the review continues without it. Liveness is the step's
// idle watchdog (no output for five minutes), never a wall-clock cap; `--timeout 0` turns off ocr's own deadline.

/** The review's child, `internal`: never a command, so `review.ocr` does not collide with `agw review`. */
export const OCR_WORKFLOW_ID = 'review.ocr'
export const OCR_ROUTE = 'review.ocr'
export const OCR_VERSION = '2026-10-28.2'
export const OCR_IDLE_MS = 5 * 60_000
const SIGKILL_GRACE_MS = 5_000
const STDERR_TAIL_CHARS = 2_048
const PROMPT_LINE_CHARS = 300
const SUGGESTION_CHARS = 300
const COMMENT_CHARS = 1_500
const WARNING_CHARS = 300
/** `--effort low`: one review pass instead of two cut ~6.5 to ~2.7 minutes with no loss of real findings (agent-gateway). */
const OCR_EFFORT = 'low'

/** A ref `ocr` receives as a flag value: git's alphabet, never a leading `-`. */
const REF = /^[a-zA-Z0-9._/~^@{}][a-zA-Z0-9._/~^@{}-]*$/

export const OcrInput = z
  .object({
    cwd: z
      .string()
      .refine((cwd) => cwd.startsWith('/'), { message: 'cwd must be an absolute path' })
      .describe('The checkout to review: the caller’s work tree, or a review’s throwaway clone'),
    mode: z.enum(['uncommitted', 'head', 'range']).describe('The working tree, the last commit, or a from..to range'),
    from: z.string().optional(),
    to: z.string().optional(),
    context: z.string().optional().describe('Background for the reviewer: the author’s stated intent'),
  })
  .strict()
  .superRefine((input, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message })
    if (input.mode === 'range') {
      if (!input.from || !REF.test(input.from)) issue('a range needs a `from` ref')
      if (input.to !== undefined && !REF.test(input.to)) issue('`to` is not a safe ref')
    } else if (input.from !== undefined || input.to !== undefined) {
      issue('`from` and `to` belong to mode "range"')
    }
  })

export const OcrOutput = z.object({
  block: z.string().describe('The synthesis block: findings, or why OCR did not run'),
  ran: z.boolean().describe('True once the ocr process was started'),
})
type OcrInputValue = z.output<typeof OcrInput>

export function modeArgs(input: OcrInputValue): string[] {
  if (input.mode === 'uncommitted') return []
  if (input.mode === 'head') return ['--commit', 'HEAD']
  return ['--from', input.from as string, '--to', input.to || 'HEAD']
}

/**
 * `ocr`'s protocol and base URL for a route, decided together so the pairing cannot drift. OpenAI's own models (`gpt-`)
 * keep reasoning items across `ocr`'s tool loop only over Responses (agent-gateway, probed 2026-09-24); the
 * `iu-anthropic` wire speaks Messages; anything else chat completions.
 */
export function ocrTransport(
  route: ResolvedRoute,
  iu: { anthropicBase: string; openaiBase: string },
): { protocol: 'anthropic' | 'openai' | 'openai-responses'; url: string } {
  if (route.wire === 'iu-anthropic') return { protocol: 'anthropic', url: iu.anthropicBase }
  return { protocol: route.model.startsWith('gpt-') ? 'openai-responses' : 'openai', url: iu.openaiBase }
}

/** The `ocr review` argv after the binary. */
export function ocrArgs(input: { modeArgs: string[]; repo: string; outFile: string; bgFile?: string }): string[] {
  return [
    'review',
    ...input.modeArgs,
    '--repo',
    input.repo,
    '--format',
    'json',
    '--audience',
    'human',
    '--timeout',
    '0',
    '--effort',
    OCR_EFFORT,
    '-o',
    input.outFile,
    ...(input.bgFile ? ['--background-file', input.bgFile] : []),
  ]
}

type OcrComment = { path: string; content: string; start_line: number; end_line: number; suggestion_code?: string }
type OcrSummary = {
  files_reviewed: number
  comments: number
  total_tokens: number
  input_tokens: number
  output_tokens: number
  cache_read_tokens?: number
  cache_write_tokens?: number
  elapsed: string
}
type OcrResult = {
  status: string
  llm?: { model: string }
  message?: string
  summary?: OcrSummary
  comments?: OcrComment[] | null
  warnings?: unknown[] | null
}

const truncate = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text)
const skipped = (reason: string) => `OpenCodeReview: skipped (${reason})`
const failed = (reason: string) => `OpenCodeReview: failed (${reason})`
const redact = (text: string, key: string | undefined) => (key ? text.replaceAll(key, '[redacted]') : text)

/** Compact markdown of one run for the synthesis. Zero comments still shows warnings and a non-complete status. */
export function renderOcrBlock(result: OcrResult): string {
  const comments = result.comments ?? []
  const warnings = result.warnings ?? []
  const warningsBlock =
    warnings.length > 0
      ? `\n\nWarnings:\n${warnings.map((w) => `- ${truncate(typeof w === 'string' ? w : JSON.stringify(w), WARNING_CHARS)}`).join('\n')}`
      : ''
  if (comments.length === 0) {
    const reason = result.message ? ` (${result.message})` : ''
    return `OpenCodeReview: no comments — status ${result.status}${reason}.${warningsBlock}`
  }
  const s = result.summary
  const header =
    `OpenCodeReview — model ${result.llm?.model ?? 'unknown'}` +
    (result.status === 'complete' || result.status === 'success' ? '' : `, status ${result.status}`) +
    (s ? `, ${s.files_reviewed} file(s) reviewed, ${s.comments} comment(s), ${s.elapsed} elapsed` : '')
  const lines = comments.map((c) => {
    const where = c.start_line === c.end_line ? `${c.start_line}` : `${c.start_line}-${c.end_line}`
    const suggestion = c.suggestion_code ? `\n  suggestion: ${truncate(c.suggestion_code, SUGGESTION_CHARS)}` : ''
    return `- ${escapeName(c.path)}:${where} — ${truncate(c.content, COMMENT_CHARS)}${suggestion}`
  })
  return `${header}\n\n${lines.join('\n')}${warningsBlock}`
}

function usageOf(
  model: string,
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number },
): Usage {
  // `ocr` reports tokens and no price: the cost is unknown, never 0.
  return {
    model,
    tokens: {
      input: tokens.input,
      output: tokens.output,
      cacheRead: tokens.cacheRead,
      cacheWrite: tokens.cacheWrite,
      reasoning: 0,
    },
    cost: null,
    costSource: 'unknown',
  }
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/**
 * `ocr` writes its summary only on a clean run. An idle kill, a non-zero exit or unparseable output still spent tokens,
 * and its own session log (`~/.opencodereview/sessions/<repo path, / as ->/<id>.jsonl`, one `llm_response` line per turn)
 * carries them. Best effort: telemetry on a failure path must not become a second failure. `counted` holds the logs an
 * earlier attempt of this step already read (the primary before its fallback): each log is counted once.
 */
function recoverUsage(opts: { repo: string; home: string; startedAtMs: number; counted: Set<string> }) {
  const { repo, startedAtMs, counted } = opts
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  try {
    const dir = join(opts.home, '.opencodereview', 'sessions', repo.replaceAll('/', '-').replace(/^-/, ''))
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith('.jsonl') || counted.has(entry)) continue
      const lines = readFileSync(join(dir, entry), 'utf8').split('\n')
      const first = lines.find((l) => l.trim())
      if (!first) continue
      const start = JSON.parse(first) as { type?: string; timestamp?: unknown; cwd?: unknown }
      const at = typeof start.timestamp === 'number' ? start.timestamp : Date.parse(String(start.timestamp))
      if (start.type !== 'session_start' || !Number.isFinite(at) || at < startedAtMs - 2_000 || start.cwd !== repo)
        continue
      counted.add(entry)
      for (const line of lines) {
        try {
          const rec = JSON.parse(line) as { type?: string; usage?: Record<string, unknown> }
          if (rec.type !== 'llm_response' || !rec.usage) continue
          total.input += num(rec.usage.prompt_tokens)
          total.output += num(rec.usage.completion_tokens)
          total.cacheRead += num(rec.usage.cache_read_tokens)
          total.cacheWrite += num(rec.usage.cache_write_tokens)
        } catch {
          // a malformed line of a third-party log
        }
      }
    }
  } catch {
    // no log directory: the run spent nothing we can see
  }
  return total
}

/** Runs `ocr review` and reports what it printed. Never throws for an `ocr` failure: that becomes a one-line block. */
export async function runOcr(
  input: OcrInputValue,
  scope: StepScope,
  ports: ReviewPorts,
): Promise<z.output<typeof OcrOutput>> {
  const bin = ports.which('ocr')
  if (!bin) return { block: skipped('ocr not found on PATH'), ran: false }
  let iu: ReturnType<typeof iuFromEnv>
  try {
    iu = iuFromEnv(ports.env)
  } catch (error) {
    return {
      block: skipped(`IU credentials unavailable: ${error instanceof Error ? error.message : String(error)}`),
      ran: false,
    }
  }
  // The route, then its fallback once when `ocr` exits on a provider-balance refusal.
  const primary = resolveRoute(OCR_ROUTE, ports.env)
  const fallback = fallbackRoute(primary)
  // `ocr` gets this HOME, so its session logs live under it.
  const home = ports.env.HOME ?? homedir()
  const counted = new Set<string>()

  let dir: string | undefined
  let proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined
  let killTimer: ReturnType<typeof setTimeout> | undefined
  // One timer: the abort listener and the `finally` both call this, and a second timer would be lost to `clearTimeout`.
  const terminate = () => {
    if (!proc || proc.exitCode !== null || killTimer) return
    killTree(proc, 'TERM') // the tree: `ocr` runs helpers of its own that would keep the pipes open
    killTimer = setTimeout(() => {
      if (proc && proc.exitCode === null) killTree(proc, 'KILL')
    }, SIGKILL_GRACE_MS)
  }
  scope.signal.addEventListener('abort', terminate, { once: true })
  try {
    // A private directory: the output and the background file may carry repo and diff content.
    dir = mkdtempSync(join(tmpdir(), 'agw-ocr-'))
    chmodSync(dir, 0o700)
    const outFile = join(dir, 'result.json')
    const bgFile = input.context ? join(dir, 'background.md') : undefined
    if (bgFile) writeFileSync(bgFile, input.context ?? '', { mode: 0o600 })
    let refused: string | null = null
    for (const route of fallback ? [primary, fallback] : [primary]) {
      const attemptStart = Date.now()
      const { protocol, url } = ocrTransport(route, iu)
      // Minimal env, not a copy of ours: a spawned CLI has no reason to hold whatever else this process carries.
      const env: Record<string, string> = {
        PATH: ports.env.PATH ?? '',
        HOME: home,
        TMPDIR: ports.env.TMPDIR ?? tmpdir(),
        OCR_LLM_URL: url,
        OCR_LLM_TOKEN: iu.key,
        OCR_LLM_PROTOCOL: protocol,
        OCR_LLM_MODEL: route.model,
        OCR_ENABLE_TELEMETRY: '0',
        ...(ports.env.LANG ? { LANG: ports.env.LANG } : {}),
      }
      try {
        proc = Bun.spawn([bin, ...ocrArgs({ modeArgs: modeArgs(input), repo: input.cwd, outFile, bgFile })], {
          cwd: input.cwd,
          env,
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'pipe',
          detached: true, // its own process group, so `killTree` reaches the helpers `ocr` starts
        })
      } catch (error) {
        return {
          block: failed(
            `could not start ocr: ${redact(error instanceof Error ? error.message : String(error), iu.key)}`,
          ),
          ran: refused !== null,
        }
      }
      if (scope.signal.aborted) terminate()
      const started = proc

      let stderrTail = ''
      let lastLine = ''
      const drain = async (stream: ReadableStream<Uint8Array>, onText?: (text: string) => void) => {
        const reader = stream.getReader()
        const decoder = new TextDecoder()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) return
          scope.progress() // any byte is activity: the idle watchdog is the only stop
          onText?.(decoder.decode(value, { stream: true }))
        }
      }
      let pending = ''
      await Promise.all([
        drain(started.stderr, (chunk) => {
          // Redact before cutting, so a key straddling the cut cannot survive half-masked.
          stderrTail = redact(stderrTail + chunk, iu.key).slice(-STDERR_TAIL_CHARS)
          pending += chunk
          const lines = pending.split('\n')
          pending = lines.pop() ?? ''
          for (const line of lines) if (line.trim()) lastLine = redact(line.trim(), iu.key)
        }),
        drain(started.stdout),
      ])
      const code = await started.exited
      const model = route.model
      const lastForPrompt = truncate(lastLine || 'no stderr', PROMPT_LINE_CHARS)
      if (scope.signal.aborted) {
        const spent = recoverUsage({ repo: input.cwd, home, startedAtMs: attemptStart, counted })
        scope.addUsage(usageOf(model, spent))
        return { block: skipped('review exited early'), ran: true }
      }
      if (code !== 0) {
        scope.addUsage(usageOf(model, recoverUsage({ repo: input.cwd, home, startedAtMs: attemptStart, counted })))
        const block = failed(`exit ${code}: ${lastForPrompt}`)
        // The fallback failing too answers what the primary said.
        if (refused !== null) return { block: refused, ran: true }
        if (route === primary && fallback && isBalanceFailure({ text: stderrTail })) {
          console.warn('ocr refused on provider balance; falling back', { from: primary.model, to: fallback.model })
          refused = block
          continue
        }
        return { block, ran: true }
      }
      let parsed: OcrResult
      try {
        parsed = JSON.parse(readFileSync(outFile, 'utf8')) as OcrResult
      } catch {
        scope.addUsage(usageOf(model, recoverUsage({ repo: input.cwd, home, startedAtMs: attemptStart, counted })))
        return { block: refused ?? failed('output did not parse as JSON'), ran: true }
      }
      const s = parsed.summary
      scope.addUsage(
        usageOf(model, {
          input: num(s?.input_tokens),
          output: num(s?.output_tokens),
          cacheRead: num(s?.cache_read_tokens),
          cacheWrite: num(s?.cache_write_tokens),
        }),
      )
      // Its comments quote repo content and model output: redact there too.
      return { block: redact(renderOcrBlock(parsed), iu.key), ran: true }
    }
    return { block: refused ?? failed('no route ran'), ran: true }
  } finally {
    scope.signal.removeEventListener('abort', terminate)
    terminate()
    if (proc && proc.exitCode === null) await proc.exited
    clearTimeout(killTimer)
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
}

/** `review.ocr`: optional expensive work, refused at admission by the wallet gate (`optionalExpensive`); internal. */
export function createOcrWorkflow(ports: ReviewPorts): HostWorkflow {
  const workflow = defineWorkflow({
    id: OCR_WORKFLOW_ID,
    version: OCR_VERSION,
    input: OcrInput,
    output: OcrOutput,
    async run(ctx, input) {
      return await ctx.step('ocr', (scope) => runOcr(input, scope, ports), { idleTimeoutMs: OCR_IDLE_MS })
    },
  })
  return {
    workflow,
    summary: 'OpenCodeReview over a diff: the optional, expensive reviewer of the review workflow (wallet-gated)',
    optionalExpensive: true,
    internal: true,
  }
}
