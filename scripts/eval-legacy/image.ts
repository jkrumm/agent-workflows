#!/usr/bin/env bun
/**
 * The legacy arm of the `image` port's pre-registered rule (`docs/research/2026-10-29-wave8-ports.md` §image): runs the
 * recorded cases (`$AGW_EVAL_DIR/image/cases.jsonl`, the same file `agw eval run image` replays) through `imgcli gen --json`
 * and `imgcli cutout --json`, and scores each result with the `image` scorer itself, so both arms are judged by one function.
 *
 *   bun scripts/eval-legacy/image.ts [--runs 1] [--ids a,b] [--imgcli imgcli] [--out report.json]
 *
 * Spends the image-gateway's money (the gateway bills the same IU endpoint): run it only when the lead says so. A case is
 * `{id, input, reference}` with the workflow input as it runs on the new path; the legacy arm reads these fields of it:
 * `prompt`, `size`, `n`, `quality`, `background`, the first of `images` (imgcli's `--edit` takes one file) and, for a
 * cutout, `file` and `model`. Differences the report cannot hide: imgcli does not snap a size (the gateway answers 400 for
 * one outside its envelope), has no `--model` for `gen` (the gateway auto-routes), and an edit with several images is
 * skipped. A cutout is written to a temp dir, never next to its source.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { readPng } from '../../packages/capabilities/src/image/png.ts'
import { casesPath, evalDir, PlainCase, readCases } from '../../packages/eval/src/index.ts'
import { ImageInput, type ImageInputValue, type ImageOutputValue } from '../../packages/host/src/workflows/image/schema.ts'
import { imageScorer } from '../../packages/host/src/workflows/image/scorer.ts'

type Args = { runs: number; ids: string[] | null; imgcli: string; out: string | null }

export function parseArgs(argv: string[]): Args {
  const args: Args = { runs: 1, ids: null, imgcli: 'imgcli', out: null }
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]]
    if (value === undefined) throw new Error(`${flag} needs a value`)
    if (flag === '--runs') args.runs = Number(value)
    else if (flag === '--ids') args.ids = value.split(',')
    else if (flag === '--imgcli') args.imgcli = value
    else if (flag === '--out') args.out = value
    else throw new Error(`unknown flag ${flag}`)
  }
  if (!Number.isInteger(args.runs) || args.runs < 1) throw new Error('--runs must be a positive integer')
  return args
}

/** The imgcli argv for a case, or why the legacy arm cannot run it. */
export function imgcliArgv(input: ImageInputValue, cutoutOut: string): { argv: string[] } | { skip: string } {
  if (input.file !== undefined) {
    const model = input.model === 'bria' ? 'bria' : 'recraft'
    return { argv: ['cutout', input.file, '--model', model, '--out', cutoutOut, '--json'] }
  }
  if (input.images.length > 1) return { skip: 'imgcli edits one image' }
  const argv = ['gen', input.prompt ?? '', '--n', String(input.n), '--json']
  if (input.size !== 'auto') argv.push('--size', input.size)
  if (input.quality !== 'auto') argv.push('--quality', input.quality)
  if (input.background !== 'auto') argv.push('--background', input.background)
  if (input.images[0]) argv.push('--edit', input.images[0])
  return { argv }
}

type GenJson = { id: string; model: string; size: string; cost_usd: number | null; latency_ms: number; images: { file: string }[] }
type CutoutJson = { id: string; model: string; file: string; cost_usd: number | null; latency_ms: number }

const fileInfo = (path: string) => {
  const bytes = new Uint8Array(readFileSync(path))
  const info = readPng(bytes)
  if (!info) throw new Error(`${path} is not a PNG`)
  return { path, bytes: statSync(path).size, ...info }
}

/** imgcli's `--json` as the `image` workflow's output, so the scorer reads both arms alike. */
export function legacyOutput(input: ImageInputValue, json: GenJson | CutoutJson): ImageOutputValue {
  const cost = { usd: json.cost_usd, source: json.cost_usd === null ? ('unknown' as const) : ('provider' as const) }
  if ('file' in json) {
    return { kind: 'cutout', generationId: json.id, model: json.model, dir: dirname(json.file), files: [fileInfo(json.file)], cost, latencyMs: json.latency_ms }
  }
  const files = json.images.map((image) => fileInfo(image.file))
  return {
    kind: input.images.length ? 'edit' : 'generate',
    generationId: json.id,
    model: json.model,
    size: json.size,
    dir: dirname(files[0]?.path ?? ''),
    files,
    cost,
    latencyMs: json.latency_ms,
  }
}

type RunRecord = {
  caseId: string
  run: number
  status: 'scored' | 'failed' | 'skipped'
  wallMs: number
  costUsd: number | null
  scores: Record<string, number> | null
  pass: boolean | null
  detail: string | null
}

async function runCase(args: Args, id: string, input: ImageInputValue, run: number, tmp: string): Promise<RunRecord> {
  const plan = imgcliArgv(input, join(tmp, `${id}-${run}-cutout.png`))
  const base = { caseId: id, run, costUsd: null, scores: null, pass: null }
  if ('skip' in plan) return { ...base, status: 'skipped', wallMs: 0, detail: plan.skip }
  const started = Date.now()
  const child = Bun.spawn([args.imgcli, ...plan.argv], { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  const wallMs = Date.now() - started
  if (code !== 0) return { ...base, status: 'failed', wallMs, detail: (stderr || stdout).trim().slice(0, 400) }
  try {
    const output = legacyOutput(input, JSON.parse(stdout.trim().split('\n').at(-1) ?? '') as GenJson | CutoutJson)
    const verdict = await imageScorer.score(input, output, { source: 'regression', signal: new AbortController().signal })
    return { ...base, status: 'scored', wallMs, costUsd: output.cost.usd, scores: verdict.scores, pass: verdict.pass, detail: verdict.feedback ?? null }
  } catch (error) {
    return { ...base, status: 'failed', wallMs, detail: error instanceof Error ? error.message : String(error) }
  }
}

export function summarize(records: RunRecord[]) {
  const scored = records.filter((r) => r.status === 'scored')
  const mean = (key: string) => {
    const values = scored.flatMap((r) => (r.scores && key in r.scores ? [r.scores[key] as number] : []))
    return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null
  }
  return {
    runs: records.length,
    scored: scored.length,
    failed: records.filter((r) => r.status === 'failed').length,
    skipped: records.filter((r) => r.status === 'skipped').length,
    passRate: scored.length ? scored.filter((r) => r.pass).length / scored.length : null,
    means: Object.fromEntries(['valid', 'count', 'size', 'alpha', 'cost'].map((k) => [k, mean(k)])),
    costUsd: scored.reduce((sum, r) => sum + (r.costUsd ?? 0), 0),
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const cases = readCases(casesPath('image', process.env), PlainCase).filter((c) => !args.ids || args.ids.includes(c.id))
  if (cases.length === 0) throw new Error('no cases to run')
  const tmp = mkdtempSync(join(tmpdir(), 'agw-image-legacy-'))
  const records: RunRecord[] = []
  try {
    for (const c of cases) {
      const input = ImageInput.parse(c.input)
      for (let run = 1; run <= args.runs; run++) {
        const record = await runCase(args, c.id, input, run, tmp)
        console.error(`${c.id} #${run}: ${record.status}${record.pass === null ? '' : record.pass ? ' pass' : ' FAIL'}${record.detail ? ` (${record.detail})` : ''}`)
        records.push(record)
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
  const report = { arm: 'legacy', scorer: imageScorer.version, at: new Date().toISOString(), summary: summarize(records), records }
  const out = args.out ?? join(evalDir(process.env), 'image', `legacy-report-${report.at.replace(/[:.]/g, '-')}.json`)
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify({ out, summary: report.summary }))
}

if (import.meta.main) await main()
