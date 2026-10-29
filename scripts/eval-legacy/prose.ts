#!/usr/bin/env bun
// Wave 7 `prose` eval, rules 1 and 2 (docs/research/2026-10-29-wave7-ports.md §prose), offline and free:
//   bun scripts/eval-legacy/prose.ts --offline        rule 1 (lint) and rule 2 (keep gate) against the legacy code
//   bun scripts/eval-legacy/prose.ts --build-cases    write $AGW_EVAL_DIR/prose/cases.jsonl (private; rules 3-4 replay it)
// The legacy code is imported from an agent-gateway checkout (AGW_LEGACY_GATEWAY, default ~/SourceRoot/agent-gateway):
// its `lintProse` and its exported `runProsePipeline` with injected adapters, so the keep decision under test is the
// legacy `judgeRewrite` itself, not a copy of it. Drafts and the recorded jobs are private and read from disk.
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { keepGate } from '../../packages/host/src/workflows/prose/gate.ts'
import {
  detectFormat,
  detectLanguage,
  type LintFinding,
  lintProse,
  type ProseLanguage,
} from '../../packages/host/src/workflows/prose/lint.ts'

const HOME = homedir()
const LEGACY = process.env.AGW_LEGACY_GATEWAY ?? join(HOME, 'SourceRoot', 'agent-gateway')
const EVAL_DIR = process.env.AGW_EVAL_DIR?.trim() || join(HOME, '.local', 'share', 'agent-workflows', 'eval')
const RECORDED = join(EVAL_DIR, '_legacy', 'agw-jobs-20261029T0352.json')
const WRITING = join(HOME, 'SourceRoot', 'modelpick', 'docs', 'experiments', 'writing', '2026-10-17')

type Medium = 'article' | 'vault' | 'landing' | 'ui' | 'chat' | 'docs' | 'briefing'
interface Draft {
  id: string
  medium: Medium
  text: string
  /** The recorded legacy job's params and result, when this draft is one. */
  recorded?: { params: Record<string, unknown>; result: { text: string; review: { scores: Record<string, number> } } }
}

// ── the ten drafts ──────────────────────────────────────────────────────────────────────────

async function recordedDrafts(): Promise<Draft[]> {
  const jobs = JSON.parse(await Bun.file(RECORDED).text()) as { id: string; tool: string; params: string; result: string }[]
  return jobs
    .filter((job) => job.tool === 'prose')
    .map((job, i) => {
      const params = JSON.parse(job.params)
      return { id: `legacy-${i + 1}`, medium: params.medium, text: params.text, recorded: { params, result: JSON.parse(job.result) } }
    })
}

/** The modelpick writing bench (2026-10-17): one generation per task, plus the convoluted paragraph the `rewrite` task starts from. */
async function benchDrafts(): Promise<Draft[]> {
  const raw = JSON.parse(await Bun.file(join(WRITING, 'raw.json')).text()) as { generations: { task: string; model: string; text: string }[] }
  const pick = (task: string, model: string) => {
    const text = raw.generations.find((g) => g.task === task && g.model === model)?.text
    if (!text) throw new Error(`no ${task} generation by ${model} in ${WRITING}`)
    return text
  }
  const blind = await Bun.file(join(WRITING, 'blind.md')).text()
  const start = blind.indexOf('Original paragraph (the text to rewrite')
  const end = blind.indexOf('#### A', start)
  if (start < 0 || end < 0) throw new Error('the convoluted paragraph is not in blind.md')
  const paragraph = blind
    .slice(start, end)
    .split('\n')
    .filter((line) => line.startsWith('> ') && !line.startsWith('> Original paragraph'))
    .map((line) => line.slice(2))
    .join('\n')
    .trim()
  return [
    { id: 'article-en', medium: 'article', text: pick('en-article', 'gemini-4-argon') },
    { id: 'vault-de', medium: 'vault', text: pick('de-tech', 'claude-opus-4-6') },
    { id: 'landing', medium: 'landing', text: pick('landing', 'gemini-4-argon') },
    { id: 'ui', medium: 'ui', text: pick('ui-copy', 'gemini-4-argon') },
    { id: 'briefing', medium: 'briefing', text: pick('de-briefing', 'claude-fable-5-1') },
    { id: 'docs', medium: 'docs', text: paragraph },
  ]
}

// ── legacy ─────────────────────────────────────────────────────────────────────────────────

interface LegacyLint {
  lintProse(text: string, language: ProseLanguage): LintFinding[]
  detectLanguage(text: string): ProseLanguage
  detectFormat(text: string): string
}
interface LegacyProse {
  PROSE_INPUT: { parse(params: unknown): Record<string, unknown> }
  runProsePipeline(
    params: Record<string, unknown>,
    models: { writer: string; reviewer: string },
    deps: object,
  ): Promise<{ kept: 'rewrite' | 'original'; keptReason?: string }>
}

const legacyLint = (await import(join(LEGACY, 'server/lib/prose-lint.ts'))) as LegacyLint
const legacyProse = (await import(join(LEGACY, 'server/jobs/handlers/prose.ts'))) as LegacyProse

/** The legacy keep decision on (original, rewrite): the real pipeline, with the model calls replaced by canned ones. */
async function legacyKeep(original: string, rewrite: string, params: Record<string, unknown>) {
  const review = {
    scores: { verdict_first: 3, structure: 3, no_repetition: 3, concision: 3, precision: 3, clarity: 3, visual_fit: 3, naturalness: 3, engagement: 3 },
    notes: [],
    visualSuggestions: [],
  }
  const deps = {
    loadVoice: async () => 'voice',
    review: async () => ({ data: review, model: 'reviewer' }),
    write: async () => ({ text: rewrite }),
  }
  const parsed = legacyProse.PROSE_INPUT.parse({ ...params, text: original })
  return legacyProse.runProsePipeline(parsed, { writer: 'writer', reviewer: 'reviewer' }, deps)
}

// ── rule 1: lint ───────────────────────────────────────────────────────────────────────────

const key = (f: LintFinding) => `${f.rule}@${f.line}: ${f.excerpt}`

/** Beyond the ten drafts: text that fires the lexicon (EN) and the Nominalstil rules (DE), which the drafts barely do. */
const LEXICON_PROBES: Draft[] = [
  { id: 'probe-en', medium: 'article', text: 'We delve into a crucial topic. It is not just a cache, it is a seamless tapestry. We leverage it to unlock robust results.' },
  {
    id: 'probe-de',
    medium: 'vault',
    text: 'Die Durchführung der Überprüfung der Konfiguration erfolgt durch die Anwendung der Prüfung. Es wird gemacht, was gemacht werden muss, und es wird dabei beachtet, dass das Deployment nicht nur schnell, sondern auch sicher ist.',
  },
]

function rule1(drafts: Draft[]): boolean {
  console.log('\n== Rule 1: lint findings equal the legacy lint on all drafts (and two lexicon probes) ==')
  let failures = 0
  for (const draft of [...drafts, ...LEXICON_PROBES]) {
    const legacyLang = legacyLint.detectLanguage(draft.text)
    const ours = { language: detectLanguage(draft.text), format: detectFormat(draft.text) }
    const problems: string[] = []
    if (ours.language !== legacyLang) problems.push(`language ${ours.language} != legacy ${legacyLang}`)
    if (ours.format !== legacyLint.detectFormat(draft.text)) problems.push('format differs')
    // The detected language, then each language forced: every rule set runs on every draft.
    const counts: Record<string, number> = {}
    for (const language of [legacyLang, 'en', 'de', 'neutral'] as ProseLanguage[]) {
      const a = lintProse(draft.text, language).map(key)
      const b = legacyLint.lintProse(draft.text, language).map(key)
      counts[language] = a.length
      const missing = b.filter((k) => !a.includes(k))
      const extra = a.filter((k) => !b.includes(k))
      if (missing.length || extra.length || a.length !== b.length)
        problems.push(`[${language}] only legacy: ${JSON.stringify(missing)}; only ours: ${JSON.stringify(extra)}`)
    }
    if (problems.length) failures++
    console.log(
      `${problems.length ? 'DIFF' : 'ok  '} ${draft.id.padEnd(10)} ${draft.medium.padEnd(8)} ${legacyLang.padEnd(7)} findings en/de/neutral: ${counts.en}/${counts.de}/${counts.neutral}`,
    )
    for (const p of problems) console.log(`       ${p}`)
  }
  console.log(`Rule 1: ${failures === 0 ? 'PASS' : 'FAIL'} (${drafts.length + LEXICON_PROBES.length - failures}/${drafts.length + LEXICON_PROBES.length} texts identical)`)
  return failures === 0
}

// ── rule 2: keep gate ──────────────────────────────────────────────────────────────────────

const URL_RE = /https?:\/\/[^\s)>\]"']+/
const FENCE_RE = /```[^\n]*\n[\s\S]*?\n```/

/** Synthetic rewrites of a faithful rewrite, one per way a rewrite can break the contract; null when it does not apply. */
const MUTATIONS: Record<string, (rewrite: string) => string | null> = {
  'lost URL': (r) => (URL_RE.test(r) ? r.replace(URL_RE, 'the docs') : null),
  'lost fence': (r) => (FENCE_RE.test(r) ? r.replace(FENCE_RE, '') : null),
  'added fence': (r) => `${r}\n\n\`\`\`sh\nrm -rf build\n\`\`\``,
  'added URL': (r) => `${r}\n\nSee also https://example.org/added-by-the-rewrite`,
  'open fence': (r) => `${r}\n\n\`\`\`ts\nconst unclosed = true`,
  'worsened rule': (r) => `${r}\n\nWe leverage it. We delve into it. It is a crucial, robust, seamless tapestry.`,
  'format switch': (r) => (detectFormat(r) === 'markdown' ? `<h1>Title</h1>\n<p>${r.replace(/\n+/g, ' ')}</p>` : `# Title\n\n${r.replace(/<[^>]+>/g, ' ')}`),
}

const SYNTHETIC_ORIGINAL = [
  '# Cache rollout',
  '',
  'We leverage the new cache. See https://example.com/docs/cache and [[Cache notes]] for the numbers.',
  '',
  '```ts',
  'const ttl = 60',
  '```',
  '',
  'Latency dropped from 120 ms to 40 ms. Latency dropped from 120 ms to 40 ms.',
].join('\n')
const SYNTHETIC_REWRITE = [
  '# Cache rollout',
  '',
  'The new cache cut latency from 120 ms to 40 ms. Numbers: https://example.com/docs/cache and [[Cache notes]].',
  '',
  '```ts',
  'const ttl = 60',
  '```',
].join('\n')

async function rule2(drafts: Draft[]): Promise<boolean> {
  console.log('\n== Rule 2: keep decision equals the legacy judgeRewrite on the recorded pairs and synthetic negatives ==')
  const pairs: { name: string; original: string; rewrite: string; params: Record<string, unknown> }[] = []
  const bases = [
    ...drafts.filter((d) => d.recorded).map((d) => ({ name: d.id, original: d.text, rewrite: (d.recorded as NonNullable<Draft['recorded']>).result.text.trim(), params: d.recorded?.params ?? {} })),
    { name: 'synthetic', original: SYNTHETIC_ORIGINAL, rewrite: SYNTHETIC_REWRITE, params: { medium: 'docs' } },
  ]
  let skipped = 0
  for (const base of bases) {
    pairs.push({ ...base, name: `${base.name} (recorded rewrite)` })
    for (const [label, mutate] of Object.entries(MUTATIONS)) {
      const rewrite = mutate(base.rewrite)
      if (rewrite === null || rewrite === base.rewrite) skipped++
      else pairs.push({ ...base, name: `${base.name} + ${label}`, rewrite })
    }
  }
  let decisionDiffs = 0
  let reasonDiffs = 0
  const tally = { rewrite: 0, original: 0 }
  for (const pair of pairs) {
    const legacy = await legacyKeep(pair.original, pair.rewrite, pair.params)
    const ours = keepGate({ original: pair.original, rewrite: pair.rewrite, language: (pair.params.language as ProseLanguage | 'auto') ?? 'auto' })
    tally[legacy.kept]++
    const same = legacy.kept === ours.kept
    const sameReason = (legacy.keptReason ?? null) === (ours.reason ?? null)
    if (!same) decisionDiffs++
    if (!sameReason) reasonDiffs++
    if (!same || !sameReason)
      console.log(`${same ? 'reason' : 'DIFF  '} ${pair.name}: legacy ${legacy.kept} (${legacy.keptReason ?? '-'}) / ours ${ours.kept} (${ours.reason ?? '-'})`)
  }
  console.log(`${pairs.length} pairs (${skipped} mutations did not apply), legacy kept ${tally.rewrite} rewrites and rejected ${tally.original}.`)
  console.log(`Decisions differing: ${decisionDiffs}; reason strings differing: ${reasonDiffs}.`)
  console.log(`Rule 2: ${decisionDiffs === 0 ? 'PASS' : 'FAIL'} (${pairs.length - decisionDiffs}/${pairs.length} = ${(((pairs.length - decisionDiffs) / pairs.length) * 100).toFixed(0)} % equal)`)
  return decisionDiffs === 0
}

// ── cases for the live rules ───────────────────────────────────────────────────────────────

function writeCases(drafts: Draft[]) {
  const lines = drafts.map((draft) => {
    const { model: _w, reviewModel: _r, text: _t, ...recordedInput } = draft.recorded?.params ?? {}
    const input = { ...recordedInput, text: draft.text, medium: draft.medium }
    const language = legacyLint.detectLanguage(draft.text)
    const reference: Record<string, unknown> = { lintCount: legacyLint.lintProse(draft.text, language).length }
    if (draft.recorded) reference.scores = draft.recorded.result.review.scores
    return JSON.stringify({ id: draft.id, input, reference })
  })
  const path = join(EVAL_DIR, 'prose', 'cases.jsonl')
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, `${lines.join('\n')}\n`, { mode: 0o600 })
  console.log(`wrote ${lines.length} cases to ${path}`)
}

const drafts = [...(await recordedDrafts()), ...(await benchDrafts())]
if (process.argv.includes('--build-cases')) {
  writeCases(drafts)
} else {
  const ok = [rule1(drafts), await rule2(drafts)]
  process.exit(ok.every(Boolean) ? 0 : 1)
}
