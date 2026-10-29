#!/usr/bin/env bun
/**
 * The legacy arm of the `image` port's pre-registered rule (`docs/research/2026-10-29-wave8-ports.md` §image), and the
 * rule itself: runs the recorded cases (`$AGW_EVAL_DIR/image/cases.jsonl`, the same file `agw eval run image` replays)
 * through L = `imgcli gen|cutout --json` (image-gateway) and N = `agw image`, one run per case each, scores both with the
 * `image` scorer, and applies the four criteria (`rule.ts`): valid and alpha, request parameters equal per case, per-case
 * cost ratio and N priced, median wall.
 *
 *   bun scripts/eval-legacy/image.ts [--arm both|legacy|new] [--ids a,b] [--imgcli imgcli] [--agw agw] [--out report.json]
 *
 * Spends the team key's money on both arms: run it only when the lead says so. A case is `{id, input, reference}` with the
 * workflow input as it runs on the new path, and it must carry the parameters the rule compares (model-free `size`, `n`,
 * `quality: low` for a generation). The legacy arm reads `prompt`, `size`, `n`, `quality`, `background`, the first of
 * `images` (imgcli's `--edit` takes one file) and, for a cutout, `file` and `model`. What the report cannot hide:
 * imgcli does not snap a size (the gateway answers 400 for one outside its envelope), has no `--model` for `gen` (the
 * gateway auto-routes), and an edit with several images is skipped. A cutout goes to a temp dir, never next to its source.
 * N's cost is the run record's (`agw`'s answer carries it), L's is imgcli's `cost_usd`; wall is measured around each call.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { readPng } from '../../packages/capabilities/src/image/png.ts'
import { casesPath, evalDir, PlainCase, readCases } from '../../packages/eval/src/index.ts'
import { type ArmResult, type CaseResult, evaluateRule } from '../../packages/host/src/workflows/image/rule.ts'
import { ImageInput, ImageOutput, type ImageInputValue, type ImageOutputValue } from '../../packages/host/src/workflows/image/schema.ts'
import { imageScorer } from '../../packages/host/src/workflows/image/scorer.ts'

type Arm = 'both' | 'legacy' | 'new'
type Args = { arm: Arm; ids: string[] | null; imgcli: string; agw: string; out: string | null }

export function parseArgs(argv: string[]): Args {
  const args: Args = { arm: 'both', ids: null, imgcli: 'imgcli', agw: 'agw', out: null }
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]]
    if (value === undefined) throw new Error(`${flag} needs a value`)
    if (flag === '--arm') {
      if (value !== 'both' && value !== 'legacy' && value !== 'new') throw new Error('--arm must be both, legacy or new')
      args.arm = value
    } else if (flag === '--ids') args.ids = value.split(',')
    else if (flag === '--imgcli') args.imgcli = value
    else if (flag === '--agw') args.agw = value
    else if (flag === '--out') args.out = value
    else throw new Error(`unknown flag ${flag}`)
  }
  return args
}

/** The imgcli argv for a case, or why the legacy arm cannot run it. */
export function imgcliArgv(input: ImageInputValue, cutoutOut: string): { argv: string[] } | { skip: string } {
  if (input.file !== undefined) {
    return { argv: ['cutout', input.file, '--model', input.model === 'bria' ? 'bria' : 'recraft', '--out', cutoutOut, '--json'] }
  }
  if (input.images.length > 1) return { skip: 'imgcli edits one image' }
  const argv = ['gen', input.prompt ?? '', '--n', String(input.n ?? 1), '--json']
  if (input.size && input.size !== 'auto') argv.push('--size', input.size)
  if (input.quality && input.quality !== 'auto') argv.push('--quality', input.quality)
  if (input.background && input.background !== 'auto') argv.push('--background', input.background)
  if (input.enhance) argv.push('--enhance')
  if (input.images[0]) argv.push('--edit', input.images[0])
  return { argv }
}

/** The `agw` argv for a case: the workflow's flags are its input's properties. */
export function agwArgv(input: ImageInputValue): string[] {
  const argv = ['image']
  if (input.prompt !== undefined) argv.push(input.prompt)
  const flags: [string, string | number | undefined][] = [
    ['--file', input.file],
    ['--size', input.size],
    ['--n', input.n],
    ['--quality', input.quality],
    ['--model', input.model],
    ['--background', input.background],
  ]
  for (const [flag, value] of flags) if (value !== undefined) argv.push(flag, String(value))
  if (input.images.length) argv.push('--images', JSON.stringify(input.images))
  if (input.enhance) argv.push('--enhance')
  argv.push('--format', 'json')
  return argv
}

type GenJson = { id: string; model: string; size: string; quality?: string; cost_usd: number | null; latency_ms: number; images: { file: string }[] }
type CutoutJson = { id: string; model: string; file: string; cost_usd: number | null; latency_ms: number }

const fileInfo = (path: string) => {
  const info = readPng(new Uint8Array(readFileSync(path)))
  if (!info) throw new Error(`${path} is not a PNG`)
  return { path, bytes: statSync(path).size, ...info }
}

/** imgcli's `--json` as the `image` workflow's output, so the scorer and the rule read both arms alike. */
export function legacyOutput(input: ImageInputValue, json: GenJson | CutoutJson): ImageOutputValue {
  const cost = { usd: json.cost_usd, source: json.cost_usd === null ? ('unknown' as const) : ('provider' as const) }
  if ('file' in json) {
    return { kind: 'cutout', generationId: json.id, model: json.model, params: { model: json.model, n: 1, returned: 1 }, dir: dirname(json.file), files: [fileInfo(json.file)], cost, latencyMs: json.latency_ms }
  }
  const files = json.images.map((image) => fileInfo(image.file))
  return {
    kind: input.images.length ? 'edit' : 'generate',
    generationId: json.id,
    model: json.model,
    params: { model: json.model, size: json.size, ...(json.quality ? { quality: json.quality } : {}), n: input.n ?? 1, returned: files.length },
    size: json.size,
    dir: dirname(files[0]?.path ?? ''),
    files,
    cost,
    latencyMs: json.latency_ms,
  }
}

type Run = { result: ArmResult | null; status: 'scored' | 'failed' | 'skipped'; detail: string | null; pass: boolean | null }

const spawn = async (argv: string[]) => {
  const started = Date.now()
  const child = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return { stdout, stderr, code, wallMs: Date.now() - started }
}

async function score(input: ImageInputValue, output: ImageOutputValue, costUsd: number | null, wallMs: number): Promise<Run> {
  const verdict = await imageScorer.score(input, output, { source: 'regression', signal: new AbortController().signal })
  return { status: 'scored', result: { output, scores: verdict.scores, costUsd, wallMs }, detail: verdict.feedback ?? null, pass: verdict.pass }
}

async function runLegacy(args: Args, input: ImageInputValue, cutoutOut: string): Promise<Run> {
  const plan = imgcliArgv(input, cutoutOut)
  if ('skip' in plan) return { status: 'skipped', result: null, detail: plan.skip, pass: null }
  const run = await spawn([args.imgcli, ...plan.argv])
  if (run.code !== 0) return { status: 'failed', result: null, detail: (run.stderr || run.stdout).trim().slice(0, 400), pass: null }
  try {
    const output = legacyOutput(input, JSON.parse(run.stdout.trim().split('\n').at(-1) ?? '') as GenJson | CutoutJson)
    return await score(input, output, output.cost.usd, run.wallMs)
  } catch (error) {
    return { status: 'failed', result: null, detail: error instanceof Error ? error.message : String(error), pass: null }
  }
}

async function runNew(args: Args, input: ImageInputValue): Promise<Run> {
  const run = await spawn([args.agw, ...agwArgv(input)])
  if (run.code !== 0) return { status: 'failed', result: null, detail: (run.stderr || run.stdout).trim().slice(0, 400), pass: null }
  try {
    const envelope = JSON.parse(run.stdout) as { status?: string; output?: unknown; cost?: number | null; error?: { message?: string } }
    if (envelope.status !== 'done') return { status: 'failed', result: null, detail: `run ${envelope.status}: ${envelope.error?.message ?? ''}`, pass: null }
    const output = ImageOutput.parse(envelope.output)
    // The run record's cost is the rule's; the output's is the same sum when the record is not in the answer yet.
    return await score(input, output, envelope.cost ?? output.cost.usd, run.wallMs)
  } catch (error) {
    return { status: 'failed', result: null, detail: error instanceof Error ? error.message : String(error), pass: null }
  }
}

const label = (r: Run) => `${r.status}${r.pass === null ? '' : r.pass ? ' pass' : ' FAIL'}${r.detail ? ` (${r.detail})` : ''}`

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const cases = readCases(casesPath('image', process.env), PlainCase).filter((c) => !args.ids || args.ids.includes(c.id))
  if (cases.length === 0) throw new Error('no cases to run')
  const tmp = mkdtempSync(join(tmpdir(), 'agw-image-legacy-'))
  const records: { caseId: string; legacy?: Run; new?: Run }[] = []
  const paired: CaseResult[] = []
  try {
    for (const c of cases) {
      const input = ImageInput.parse(c.input)
      const record: (typeof records)[number] = { caseId: c.id }
      if (args.arm !== 'new') record.legacy = await runLegacy(args, input, join(tmp, `${c.id}-cutout.png`))
      if (args.arm !== 'legacy') record.new = await runNew(args, input)
      console.error(`${c.id}: L ${record.legacy ? label(record.legacy) : '-'} | N ${record.new ? label(record.new) : '-'}`)
      records.push(record)
      if (record.legacy?.result && record.new?.result) paired.push({ id: c.id, input, n: record.new.result, l: record.legacy.result })
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
  const bothArms = args.arm === 'both'
  // The rule needs every case from both arms: a case an arm failed or skipped is a failed case, not a smaller sample.
  const rule = bothArms ? { cases: cases.length, paired: paired.length, ...(paired.length === cases.length ? evaluateRule(paired) : { pass: false, criteria: [{ name: 'every case ran on both arms', pass: false, detail: `${paired.length}/${cases.length} paired` }] }) } : null
  const report = { scorer: imageScorer.version, at: new Date().toISOString(), arm: args.arm, rule, records }
  const out = args.out ?? join(evalDir(process.env), 'image', `report-${report.at.replace(/[:.]/g, '-')}.json`)
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify({ out, rule }))
}

if (import.meta.main) await main()
