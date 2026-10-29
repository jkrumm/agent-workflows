#!/usr/bin/env bun
// Wave 8 speech and transcriptions evals (docs/research/2026-10-29-wave8-ports.md §speech, §transcriptions): the
// OpenAI-compatible TTS/STT door, legacy arm L (audio-gateway as Hermes calls it today) against the new arm N (the
// audio process's door). Three steps, each resumable from the rows file:
//
//   bun scripts/eval-legacy/audio.ts run   <speech|transcriptions> [--arms L,N] [--tag T] [--ids a,b] [--dry-run]
//   bun scripts/eval-legacy/audio.ts cost  <speech|transcriptions> --tag T
//   bun scripts/eval-legacy/audio.ts score <speech|transcriptions> --tag T
//
// `run` calls the doors (live spend: the lead runs it after merge and deploy) and keeps every body on disk; `cost` prices
// each call: L from audio-gateway's own usage ledger (copied from the VPS, priced with its own `computeCost`), N from
// the run record the door's `agw-run-id` header names; `score` applies the pre-registered rules and prints numbers only.
//
// Environment: AGW_EVAL_DIR (cases `<dir>/<suite>/cases.jsonl`, transcription inputs beside them; rows and bodies go
// to `<dir>/<suite>/runs/<tag>/`, mode 0600), AGW_AUDIO_URL (N's base, ending in /v1) and AGW_AUDIO_KEY (its bearer,
// optional), AGW_LEGACY_AUDIO_DIR (audio-gateway's checkout, default ~/SourceRoot/audio-gateway), AGW_PG_SCHEMA
// (default agw). L's URL and key are read from ~/.hermes/config.yaml (`tts.openai`). Cases, bodies and transcripts
// are private: nothing here prints them.
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { evalDir } from '../../packages/eval/src/index.ts'
import { type AudioRouteId, audioRoutes } from '../../packages/audio/src/routes.ts'
import { measureFromOpenAiUsage } from '../../packages/audio/src/usage.ts'

type Suite = 'speech' | 'transcriptions'
type Arm = 'L' | 'N'

interface SpeechCase {
  id: string
  kind: 'chat' | 'stream' | 'briefing' | 'elevenlabs' | 'delivery'
  route: AudioRouteId
  input: string
  response_format: 'mp3' | 'opus' | 'wav' | 'pcm'
  voice?: string
  delivery?: string
}
interface SttCase {
  id: string
  file: string
  language?: string
}

/** One door call. `run` is 1-based (pcm cases run 3 times per arm, transcriptions twice on L: L and L′). */
interface CallRow {
  kind: 'call'
  suite: Suite
  arm: Arm
  id: string
  run: number
  /** speech: the case's format; transcriptions: json, or the format check's text/srt/vtt/verbose_json; `stt-check`: N's transcription of N's audio. */
  purpose: 'case' | 'format' | 'intelligible'
  format: string
  caller: string
  status: number
  ttfbMs: number | null
  wallMs: number
  title: string | null
  runId: string | null
  body: string
  error?: string
}
interface CostRow {
  kind: 'cost'
  arm: Arm
  caller: string
  costUsd: number | null
  /** Billed calls without a price. */
  unpriced: number
}
type Row = CallRow | CostRow

const env = process.env
/** The route table as the door resolves it (route overrides applied), so a case names a route, never a model. */
const ROUTES = audioRoutes(env)
const HOME = homedir()
const LEGACY_AUDIO = env.AGW_LEGACY_AUDIO_DIR ?? join(HOME, 'SourceRoot', 'audio-gateway')
const PROD_DB_GLOB = 'vps:/var/lib/audio-gateway/usage.db*'
const PG_PASSWORD_REF = 'op://mini/vps-dev/AGENT_WORKFLOWS_DB_PASSWORD'
const RUN_ID_HEADER = 'agw-run-id'
/** A hang guard on one door call, never a budget. */
const CALL_TIMEOUT_MS = 30 * 60_000

// ── arguments, files ─────────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]) {
  const [command, suite] = argv
  if (!['run', 'cost', 'score'].includes(command ?? '')) throw new Error('usage: audio.ts <run|cost|score> <suite> …')
  if (suite !== 'speech' && suite !== 'transcriptions') throw new Error('suite: speech or transcriptions')
  const value = (flag: string) => {
    const i = argv.indexOf(flag)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const tag = value('--tag') ?? new Date().toISOString().replace(/[-:]/g, '').slice(0, 13)
  if (command !== 'run' && !value('--tag')) throw new Error(`${command} needs --tag`)
  return {
    command: command as 'run' | 'cost' | 'score',
    suite: suite as Suite,
    tag,
    arms: (value('--arms')?.split(',') ?? ['L', 'N']) as Arm[],
    ids: value('--ids')?.split(','),
    dryRun: argv.includes('--dry-run'),
  }
}

const suiteDir = (suite: Suite) => join(evalDir(env), suite)
const runDir = (suite: Suite, tag: string) => join(suiteDir(suite), 'runs', tag)

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T)
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 300)

// ── arms ─────────────────────────────────────────────────────────────────────────────────────

interface Door {
  base: string
  key: string | null
}

function doors(): Record<Arm, Door | null> {
  const hermes = Bun.YAML.parse(readFileSync(join(HOME, '.hermes', 'config.yaml'), 'utf8')) as {
    tts?: { openai?: { base_url?: string; api_key?: string } }
  }
  const legacy = hermes.tts?.openai
  return {
    L: legacy?.base_url ? { base: legacy.base_url.replace(/\/+$/, ''), key: legacy.api_key ?? null } : null,
    N: env.AGW_AUDIO_URL ? { base: env.AGW_AUDIO_URL.replace(/\/+$/, ''), key: env.AGW_AUDIO_KEY ?? null } : null,
  }
}

/** One call; the body is read chunk by chunk so a pcm stream's time to first byte is measured, then kept on disk. */
async function call(
  door: Door,
  path: string,
  body: BodyInit,
  headers: Record<string, string>,
  out: string,
): Promise<Pick<CallRow, 'status' | 'ttfbMs' | 'wallMs' | 'title' | 'runId' | 'error'>> {
  const started = performance.now()
  try {
    const res = await fetch(`${door.base}${path}`, {
      method: 'POST',
      headers: { ...headers, ...(door.key && { authorization: `Bearer ${door.key}` }) },
      body,
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    })
    const chunks: Uint8Array[] = []
    let ttfbMs: number | null = null
    let error: string | undefined
    const reader = res.body?.getReader()
    try {
      for (;;) {
        const chunk = await reader?.read()
        if (!chunk || chunk.done) break
        if (ttfbMs === null && chunk.value.byteLength > 0) ttfbMs = performance.now() - started
        chunks.push(chunk.value)
      }
    } catch (e) {
      // A pcm stream aborted after its first byte: the contract's transfer error. Kept as such, never as a clean body.
      error = `body aborted: ${errorText(e)}`
    }
    writeFileSync(out, Buffer.concat(chunks), { mode: 0o600 })
    const title = res.headers.get('x-audio-title')
    return {
      status: res.status,
      ttfbMs,
      wallMs: performance.now() - started,
      title: title === null ? null : decodeURIComponent(title),
      runId: res.headers.get(RUN_ID_HEADER),
      ...(error && { error }),
    }
  } catch (e) {
    writeFileSync(out, '', { mode: 0o600 })
    return { status: 0, ttfbMs: null, wallMs: performance.now() - started, title: null, runId: null, error: errorText(e) }
  }
}

const SPEECH_EXT = { mp3: 'mp3', opus: 'ogg', wav: 'wav', pcm: 'pcm' } as const
const STT_EXT: Record<string, string> = { json: 'json', text: 'txt', srt: 'srt', vtt: 'vtt', verbose_json: 'json' }

async function run(args: ReturnType<typeof parseArgs>) {
  const dir = runDir(args.suite, args.tag)
  const rowsPath = join(dir, 'rows.jsonl')
  const arms = doors()
  for (const arm of args.arms) if (!arms[arm]) throw new Error(`arm ${arm} has no URL (L: ~/.hermes/config.yaml, N: AGW_AUDIO_URL)`)
  let cases = readJsonl<SpeechCase & SttCase>(join(suiteDir(args.suite), 'cases.jsonl'))
  if (args.ids) cases = cases.filter((c) => args.ids?.includes(c.id))
  if (cases.length === 0) throw new Error(`no ${args.suite} cases`)
  for (const c of cases) {
    if (args.suite === 'speech' && !ROUTES[c.route]) throw new Error(`case ${c.id}: unknown route ${c.route}`)
    if (args.suite === 'transcriptions' && !existsSync(join(suiteDir('transcriptions'), c.file))) {
      throw new Error(`case ${c.id}: ${c.file} is not in the eval dir`)
    }
  }
  const done = new Set(readJsonl<Row>(rowsPath).flatMap((r) => (r.kind === 'call' ? [`${r.arm}|${r.id}|${r.purpose}|${r.format}|${r.run}`] : [])))
  if (args.dryRun) {
    console.log(`dry run ok: ${cases.length} ${args.suite} case(s), arms ${args.arms.join(',')} configured, tag ${args.tag}, ${done.size} call(s) already recorded`)
    return
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(rowsPath, '', { flag: 'a', mode: 0o600 })
  const append = (row: Row) => appendFileSync(rowsPath, `${JSON.stringify(row)}\n`)
  const tally = { calls: 0, failed: 0, skipped: 0 }

  const once = async (
    arm: Arm,
    id: string,
    purpose: CallRow['purpose'],
    format: string,
    n: number,
    send: (door: Door, caller: string, out: string) => ReturnType<typeof call>,
    ext: string,
  ) => {
    if (done.has(`${arm}|${id}|${purpose}|${format}|${n}`)) {
      tally.skipped++
      return
    }
    const caller = `eval-w8-${args.tag}-${arm}-${id}-${purpose}-${format}-${n}`
    const body = join(dir, `${arm}-${id}-${purpose}-${format}-${n}.${ext}`)
    const result = await send(arms[arm] as Door, caller, body)
    append({ kind: 'call', suite: args.suite, arm, id, run: n, purpose, format, caller, body: basename(body), ...result })
    tally.calls++
    if (result.status !== 200 || result.error) tally.failed++
  }

  if (args.suite === 'speech') {
    for (const c of cases) {
      const runs = c.response_format === 'pcm' ? 3 : 1
      for (const arm of args.arms) {
        for (let n = 1; n <= runs; n++) {
          await once(arm, c.id, 'case', c.response_format, n, (door, caller, out) =>
            call(
              door,
              '/audio/speech',
              JSON.stringify({
                model: ROUTES[c.route].model,
                input: c.input,
                voice: c.voice,
                response_format: c.response_format,
                ...(c.delivery && { delivery: c.delivery }),
              }),
              { 'content-type': 'application/json', 'x-audio-source': caller },
              out,
            ), SPEECH_EXT[c.response_format])
        }
      }
    }
    // intelligible: N's own STT door transcribes N's mp3 of the chat cases.
    if (args.arms.includes('N')) {
      for (const c of cases.filter((x) => x.kind === 'chat')) {
        const audio = join(dir, `N-${c.id}-case-${c.response_format}-1.${SPEECH_EXT[c.response_format]}`)
        if (!existsSync(audio)) continue
        await once('N', c.id, 'intelligible', 'json', 1, (door, caller, out) => {
          const form = new FormData()
          form.append('file', new File([readFileSync(audio)], basename(audio), { type: 'audio/mpeg' }))
          form.append('response_format', 'json')
          return call(door, '/audio/transcriptions', form, { 'x-audio-source': caller }, out)
        }, 'json')
      }
    }
  } else {
    const shortest = [...cases].sort((a, b) => probeDuration(join(suiteDir('transcriptions'), a.file)) - probeDuration(join(suiteDir('transcriptions'), b.file)))[0]
    const stt = (c: SttCase, format: string) => (door: Door, caller: string, out: string) => {
      const path = join(suiteDir('transcriptions'), c.file)
      const form = new FormData()
      form.append('file', new File([readFileSync(path)], basename(path)))
      form.append('response_format', format)
      if (c.language) form.append('language', c.language)
      return call(door, '/audio/transcriptions', form, { 'x-audio-source': caller }, out)
    }
    for (const c of cases) {
      for (const arm of args.arms) {
        for (let n = 1; n <= (arm === 'L' ? 2 : 1); n++) await once(arm, c.id, 'case', 'json', n, stt(c, 'json'), 'json')
      }
    }
    if (shortest && args.arms.includes('N')) {
      for (const format of ['text', 'srt', 'vtt', 'verbose_json']) {
        await once('N', shortest.id, 'format', format, 1, stt(shortest, format), STT_EXT[format] ?? 'txt')
      }
    }
  }
  console.log(`${args.suite} ${args.tag}: ${tally.calls} call(s), ${tally.failed} failed, ${tally.skipped} already recorded`)
}

// ── cost ─────────────────────────────────────────────────────────────────────────────────────

interface LegacyUsage {
  computeCost(model: string, c: Record<string, number | null>): { costUsd: number | null; costSource: string }
  normalizeModel(raw: string): string
}

/** audio-gateway's own pricing, imported from its checkout (its config reads env at import: inert values). */
async function legacyPricing(): Promise<LegacyUsage> {
  env.IU_API_KEY ??= 'unused'
  env.IU_OPENAI_BASE_URL ??= 'https://example.invalid/openai/v1'
  env.USAGE_DB = ':memory:'
  env.USAGE_SINK = 'sqlite'
  return (await import(join(LEGACY_AUDIO, 'src', 'usage.ts'))) as LegacyUsage
}

interface LegacyRow {
  endpoint: string
  model: string
  status: number
  input_tokens: number | null
  output_tokens: number | null
  audio_tokens: number | null
  audio_seconds: number | null
  input_chars: number | null
  usage_json: string | null
  caller: string
}

/** L's calls from the VPS ledger (scp, like audio-gateway's `usage:tail --prod`), priced per row; summaries excluded. */
async function legacyCosts(callers: string[]): Promise<CostRow[]> {
  const { Database } = await import('bun:sqlite')
  const pricing = await legacyPricing()
  const tmp = mkdtempSync(join(tmpdir(), 'agw-eval-audio-'))
  try {
    const copy = Bun.spawnSync(['scp', '-q', PROD_DB_GLOB, `${tmp}/`], { stdout: 'ignore', stderr: 'inherit' })
    if (!copy.success) throw new Error(`scp from the VPS failed (exit ${copy.exitCode})`)
    const db = new Database(join(tmp, 'usage.db'), { readonly: true })
    const out: CostRow[] = []
    for (const caller of callers) {
      const rows = db
        .query(
          "select endpoint, model, status, input_tokens, output_tokens, audio_tokens, audio_seconds, input_chars, usage_json, caller from usage_record where caller = ? and endpoint not like '%-request'",
        )
        .all(caller) as LegacyRow[]
      let costUsd = 0
      let unpriced = 0
      for (const r of rows) {
        const m = measureFromOpenAiUsage(r.usage_json ? JSON.parse(r.usage_json) : null)
        const priced = pricing.computeCost(pricing.normalizeModel(r.model), {
          inputTokens: r.input_tokens ?? m.inputTokens ?? null,
          outputTokens: r.output_tokens ?? m.outputTokens ?? null,
          cachedInputTokens: m.cachedTokens ?? null,
          audioTokens: r.audio_tokens ?? m.audioTokens ?? null,
          audioSeconds: r.audio_seconds ?? m.audioSeconds ?? null,
          inputChars: r.input_chars,
        })
        if (priced.costUsd === null) unpriced++
        else costUsd += priced.costUsd
      }
      out.push({ kind: 'cost', arm: 'L', caller, costUsd: rows.length === 0 ? null : costUsd, unpriced })
    }
    db.close()
    return out
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

/** N's cost from the run record its door named (`agw-run-id`): the run's cost, and the steps' unpriced calls. */
function newCosts(calls: CallRow[]): CostRow[] {
  const password = Bun.spawnSync(['secrets-run', 'read', PG_PASSWORD_REF]).stdout.toString().trim()
  if (!password) throw new Error('cannot read the journal password through secrets-run')
  const schema = env.AGW_PG_SCHEMA ?? 'agw'
  return calls.map((c) => {
    if (!c.runId) return { kind: 'cost', arm: 'N', caller: c.caller, costUsd: null, unpriced: 1 }
    const sql = `select coalesce(r.cost::text, ''), coalesce(sum(s.unpriced_calls), 0) from "${schema}".runs r left join "${schema}".steps s on s.run_id = r.id where r.id = :'id' group by r.cost`
    const res = Bun.spawnSync(
      ['psql', '-h', '127.0.0.1', '-U', 'agent_workflows', '-d', 'agent_workflows', '-AtF', '|', '-v', 'ON_ERROR_STOP=1', '-v', `id=${c.runId}`],
      { stdin: new TextEncoder().encode(sql), env: { ...env, PGPASSWORD: password } },
    )
    const [cost, unpriced] = res.stdout.toString().trim().split('|')
    return {
      kind: 'cost',
      arm: 'N',
      caller: c.caller,
      costUsd: cost ? Number(cost) : null,
      unpriced: Number(unpriced ?? 1),
    }
  })
}

async function cost(args: ReturnType<typeof parseArgs>) {
  const rowsPath = join(runDir(args.suite, args.tag), 'rows.jsonl')
  const rows = readJsonl<Row>(rowsPath)
  const calls = rows.filter((r): r is CallRow => r.kind === 'call')
  const priced = new Set(rows.flatMap((r) => (r.kind === 'cost' ? [r.caller] : [])))
  const todo = calls.filter((c) => !priced.has(c.caller))
  const costs = [
    ...(todo.some((c) => c.arm === 'L') ? await legacyCosts(todo.filter((c) => c.arm === 'L').map((c) => c.caller)) : []),
    ...newCosts(todo.filter((c) => c.arm === 'N')),
  ]
  for (const row of costs) appendFileSync(rowsPath, `${JSON.stringify(row)}\n`)
  console.log(`${args.suite} ${args.tag}: ${costs.length} call(s) priced, ${costs.filter((c) => c.costUsd === null).length} without a cost`)
}

// ── scoring ──────────────────────────────────────────────────────────────────────────────────

function probeDuration(path: string): number {
  const p = Bun.spawnSync(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', path])
  const d = Number.parseFloat(p.stdout.toString().trim())
  return Number.isFinite(d) ? d : 0
}

interface Probe {
  format: string
  codec: string
  sampleRate: number
  channels: number
  duration: number
}

function probe(path: string, rawPcm: boolean): Probe | null {
  const p = Bun.spawnSync([
    'ffprobe',
    '-v',
    'error',
    ...(rawPcm ? ['-f', 's16le', '-ar', '24000', '-ch_layout', 'mono'] : []),
    '-show_entries',
    'format=format_name,duration:stream=codec_name,sample_rate,channels',
    '-of',
    'json',
    path,
  ])
  if (p.exitCode !== 0) return null
  const json = JSON.parse(p.stdout.toString()) as {
    format?: { format_name?: string; duration?: string }
    streams?: Array<{ codec_name?: string; sample_rate?: string; channels?: number }>
  }
  const stream = json.streams?.[0]
  if (!stream) return null
  return {
    format: json.format?.format_name ?? '',
    codec: stream.codec_name ?? '',
    sampleRate: Number(stream.sample_rate ?? 0),
    channels: stream.channels ?? 0,
    duration: Number.parseFloat(json.format?.duration ?? '0') || 0,
  }
}

/** `valid`: ffprobe decodes it, the container matches the format, pcm and wav are s16le mono 24 kHz. */
function speechValid(path: string, format: string): { valid: boolean; duration: number } {
  const bytes = readFileSync(path)
  if (bytes.byteLength === 0) return { valid: false, duration: 0 }
  if (format === 'pcm') {
    const p = probe(path, true)
    return { valid: p !== null && bytes.byteLength % 2 === 0, duration: bytes.byteLength / 48_000 }
  }
  const p = probe(path, false)
  if (!p) return { valid: false, duration: 0 }
  const ok =
    format === 'mp3'
      ? p.format.includes('mp3') && p.codec === 'mp3'
      : format === 'opus'
        ? p.format.includes('ogg') && p.codec === 'opus'
        : p.format.includes('wav') && p.codec === 'pcm_s16le' && p.sampleRate === 24_000 && p.channels === 1
  return { valid: ok && p.duration > 0, duration: p.duration }
}

/** The rules' normalisation: lowercase, punctuation and inline tags stripped, whitespace collapsed. */
export function normalizeWords(text: string): string[] {
  return text
    .replace(/<[^<>\n]{1,40}>|\[[^\]\n]{1,40}\]/g, ' ')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

/** 1 − WER of `hyp` against `ref` (word-level Levenshtein over the reference length), floored at 0. */
export function agreement(ref: string, hyp: string): number {
  const a = normalizeWords(ref)
  const b = normalizeWords(hyp)
  if (a.length === 0) return b.length === 0 ? 1 : 0
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return Math.max(0, 1 - (prev[b.length] ?? 0) / a.length)
}

const median = (xs: number[]) => {
  const s = [...xs].sort((x, y) => x - y)
  const m = Math.floor(s.length / 2)
  return s.length === 0 ? Number.NaN : s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2
}
const mean = (xs: number[]) => (xs.length === 0 ? Number.NaN : xs.reduce((a, b) => a + b, 0) / xs.length)
const fmt = (n: number, digits = 3) => (Number.isFinite(n) ? n.toFixed(digits) : 'n/a')

function costTotals(calls: CallRow[], costs: Map<string, CostRow>) {
  let total = 0
  let unpriced = 0
  for (const c of calls) {
    const row = costs.get(c.caller)
    if (!row || row.costUsd === null) unpriced++
    else total += row.costUsd
    unpriced += row?.unpriced ?? 0
  }
  return { total, unpriced }
}

/** srt/vtt cues: at least one, every cue start ≤ end, starts and ends non-decreasing. */
function cuesMonotone(text: string): boolean {
  const re = /(\d\d):(\d\d):(\d\d)[,.](\d{3})\s+-->\s+(\d\d):(\d\d):(\d\d)[,.](\d{3})/g
  const sec = (h?: string, m?: string, s?: string, ms?: string) => Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000
  let last = { start: -1, end: -1 }
  let n = 0
  for (const m of text.matchAll(re)) {
    const start = sec(m[1], m[2], m[3], m[4])
    const end = sec(m[5], m[6], m[7], m[8])
    if (start > end || start < last.start || end < last.end) return false
    last = { start, end }
    n++
  }
  return n > 0
}

function score(args: ReturnType<typeof parseArgs>) {
  const dir = runDir(args.suite, args.tag)
  const rows = readJsonl<Row>(join(dir, 'rows.jsonl'))
  const calls = rows.filter((r): r is CallRow => r.kind === 'call')
  const costs = new Map(rows.flatMap((r) => (r.kind === 'cost' ? [[r.caller, r] as const] : [])))
  const of = (arm: Arm, purpose: CallRow['purpose'] = 'case') => calls.filter((c) => c.arm === arm && c.purpose === purpose)
  const verdicts: Array<[string, boolean, string]> = []

  if (args.suite === 'speech') {
    const cases = readJsonl<SpeechCase>(join(suiteDir('speech'), 'cases.jsonl'))
    const scored = cases.map((c) => {
      const arm = (a: Arm) => {
        const runs = of(a).filter((r) => r.id === c.id)
        const checks = runs.map((r) => ({ ...r, ...speechValid(join(dir, r.body), c.response_format) }))
        return {
          runs: checks,
          valid: checks.length > 0 && checks.every((r) => r.status === 200 && !r.error && r.valid),
          duration: mean(checks.map((r) => r.duration)),
        }
      }
      return { c, L: arm('L'), N: arm('N') }
    })
    const valid = scored.filter((s) => s.N.valid).length
    verdicts.push(['1 valid per case (N)', valid === cases.length, `${valid}/${cases.length}`])
    const ratios = scored.map((s) => s.N.duration / s.L.duration)
    const inBand = ratios.filter((r) => r >= 0.75 && r <= 1.33).length
    verdicts.push(['2 duration(N)/duration(L) in [0.75, 1.33] per case', inBand === cases.length, `${inBand}/${cases.length}, range ${fmt(Math.min(...ratios), 2)}–${fmt(Math.max(...ratios), 2)}`])
    const prep = scored.filter((s) => s.c.kind === 'briefing')
    const titled = prep.filter((s) => s.N.runs.every((r) => r.title)).length
    verdicts.push(['3 title on both prep cases (N)', prep.length === 2 && titled === 2, `${titled}/${prep.length}`])
    const ttfb = (a: Arm) => median(of(a).filter((r) => r.format === 'pcm' && r.ttfbMs !== null).map((r) => r.ttfbMs as number))
    const [tL, tN] = [ttfb('L'), ttfb('N')]
    verdicts.push(['4 median TTFB over the pcm runs: N ≤ L + 300 ms', tN <= tL + 300, `N ${fmt(tN, 0)} ms, L ${fmt(tL, 0)} ms (${of('N').filter((r) => r.format === 'pcm').length} + ${of('L').filter((r) => r.format === 'pcm').length} runs)`])
    const cL = costTotals(of('L'), costs)
    const cN = costTotals(of('N'), costs)
    const within = Math.abs(cN.total - cL.total) <= 0.1 * cL.total
    verdicts.push(['5 total cost(N) within ±10 % of L, every N call priced', within && cN.unpriced === 0, `N $${fmt(cN.total, 5)}, L $${fmt(cL.total, 5)}, N unpriced ${cN.unpriced}, L unpriced ${cL.unpriced}`])
    const intelligible = cases
      .filter((c) => c.kind === 'chat')
      .map((c) => {
        const t = of('N', 'intelligible').find((r) => r.id === c.id)
        if (!t || t.status !== 200) return 0
        return agreement(c.input, (JSON.parse(readFileSync(join(dir, t.body), 'utf8')) as { text?: string }).text ?? '')
      })
    verdicts.push(['6 mean intelligible over the chat cases ≥ 0.90', mean(intelligible) >= 0.9, `${fmt(mean(intelligible))} over ${intelligible.length}`])
  } else {
    const cases = readJsonl<SttCase>(join(suiteDir('transcriptions'), 'cases.jsonl'))
    const text = (c: CallRow | undefined) => {
      if (!c || c.status !== 200) return null
      return (JSON.parse(readFileSync(join(dir, c.body), 'utf8')) as { text?: string }).text ?? ''
    }
    const per = cases.map((c) => {
      const L = text(of('L').find((r) => r.id === c.id && r.run === 1))
      const L2 = text(of('L').find((r) => r.id === c.id && r.run === 2))
      const N = text(of('N').find((r) => r.id === c.id))
      return {
        nl: L !== null && N !== null ? agreement(L, N) : 0,
        ll: L !== null && L2 !== null ? agreement(L, L2) : Number.NaN,
      }
    })
    const [nl, ll] = [mean(per.map((p) => p.nl)), mean(per.map((p) => p.ll).filter(Number.isFinite))]
    verdicts.push(['1 mean agreement(N, L) ≥ mean agreement(L, L′) − 0.02', nl >= ll - 0.02, `N,L ${fmt(nl)}; L,L′ ${fmt(ll)}`])
    const floor = per.filter((p) => p.nl >= 0.85).length
    verdicts.push(['2 agreement(N, L) ≥ 0.85 per case', floor === cases.length, `${floor}/${cases.length}, min ${fmt(Math.min(...per.map((p) => p.nl)))}`])
    const formats = of('N', 'format')
    const jsonText = text(of('N').find((r) => r.id === formats[0]?.id))
    const formatOk = formats.filter((f) => {
      if (f.status !== 200) return false
      const body = readFileSync(join(dir, f.body), 'utf8')
      if (f.format === 'srt' || f.format === 'vtt') return cuesMonotone(body) && (f.format === 'srt' || body.startsWith('WEBVTT'))
      if (f.format === 'text') return body.trim().length > 0
      const v = JSON.parse(body) as { text?: string; segments?: Array<{ start: number; end: number }> }
      const segs = v.segments ?? []
      const monotone = segs.length > 0 && segs.every((s, i) => s.start <= s.end && (i === 0 || (s.start >= (segs[i - 1]?.start ?? 0) && s.end >= (segs[i - 1]?.end ?? 0))))
      return monotone && jsonText !== null && (v.text ?? '').trim() === jsonText.trim()
    }).length
    verdicts.push(['3 format 4/4 (text, srt, vtt, verbose_json)', formats.length === 4 && formatOk === 4, `${formatOk}/${formats.length}`])
    // Cost over the json cases, L's first run against N's one run (the same calls); the format calls are N-only.
    const cL = costTotals(of('L').filter((r) => r.run === 1), costs)
    const cN = costTotals(of('N'), costs)
    const within = Math.abs(cN.total - cL.total) <= 0.1 * cL.total
    verdicts.push(['4 total cost(N) within ±10 % of L, every N call priced', within && cN.unpriced === 0 && costTotals(of('N', 'format'), costs).unpriced === 0, `N $${fmt(cN.total, 5)}, L $${fmt(cL.total, 5)}, N unpriced ${cN.unpriced}`])
  }

  for (const [rule, pass, detail] of verdicts) console.log(`${pass ? 'PASS' : 'FAIL'}  ${rule}: ${detail}`)
  const passed = verdicts.every(([, pass]) => pass)
  console.log(`${args.suite} ${args.tag}: ${passed ? 'N passes' : 'N does not pass'}`)
  process.exitCode = passed ? 0 : 1
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2))
  if (args.command === 'run') await run(args)
  else if (args.command === 'cost') await cost(args)
  else score(args)
}
