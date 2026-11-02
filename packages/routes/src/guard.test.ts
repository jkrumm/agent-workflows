import { expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { CLAUDE_MODELS, DEFAULT_ROUTES, resolveRoute, routeIds } from './index.ts'
import { EASY, FAST, HARD } from './table/_shared.ts'

// The home-of-model-ids rule: no source outside `packages/routes/src/table/` names a model that the table names. The
// routes package's own test files may (they pin what the table says): exactly the files `bun test` runs, by its
// discovery patterns (bun-types docs/test/discovery.mdx).
const PACKAGES = resolve(import.meta.dir, '../..')
const OWN = 'routes'
const TABLE = join(import.meta.dir, 'table')
const TEST_FILE = new Bun.Glob('**/*{.test,_test,.spec,_spec}.{js,jsx,ts,tsx,mjs,cjs,mts,cts}')

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(path)
    else yield path
  }
}

function sourceFiles(): string[] {
  return readdirSync(PACKAGES, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== OWN)
    .map((d) => join(PACKAGES, d.name, 'src'))
    .filter(existsSync)
    .flatMap((src) => [...walk(src)])
    .concat([...walk(import.meta.dir)].filter((file) => !file.startsWith(`${TABLE}/`) && !TEST_FILE.match(file)))
}

/**
 * Every line naming a table model id as a whole token: an id inside a longer word is not one (`whisper` is a model id,
 * `<whispers>` a Gemini TTS tag). Adjacent `-`, `.`, `/` and quotes still delimit, so `'whisper'` and `x/whisper` hit.
 * Longest ids match first and their spans are blanked: a shorter id inside a longer one's match (`gemini-3.8-flash` in
 * `gemini-3.8-flash-lite-tts`) is that id, not a second one.
 */
export function findModelIds(files: Map<string, string>, ids: string[]): string[] {
  const patterns = [...ids]
    .sort((a, b) => b.length - a.length)
    .map((id) => ({
      id,
      re: new RegExp(`(?<![A-Za-z0-9_])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_])`, 'g'),
    }))
  const hits: string[] = []
  for (const [file, text] of files) {
    text.split('\n').forEach((line, i) => {
      let rest = line
      for (const { id, re } of patterns) {
        re.lastIndex = 0
        if (!re.test(rest)) continue
        hits.push(`${file}:${i + 1} contains model id "${id}"`)
        rest = rest.replace(re, (match) => ' '.repeat(match.length))
      }
    })
  }
  return hits
}

test('the table names models', () => {
  expect(modelIds().length).toBeGreaterThan(0)
})

test('no source outside the route table contains a model id from it', () => {
  const files = new Map<string, string>()
  for (const file of sourceFiles()) files.set(relative(resolve(PACKAGES, '..'), file), readFileSync(file, 'utf8'))
  expect(findModelIds(files, modelIds())).toEqual([])
})

test('a shorter id inside a longer id is not reported; the same id on its own still is', () => {
  const ids = ['gemini-9-flash', 'gemini-9-flash-lite-tts']
  const files = new Map([
    [
      'packages/x/src/a.ts',
      `const m = "gemini-9-flash-lite-tts"\nconst both = ['gemini-9-flash-lite-tts', 'gemini-9-flash']\n`,
    ],
  ])
  expect(findModelIds(files, ids)).toEqual([
    'packages/x/src/a.ts:1 contains model id "gemini-9-flash-lite-tts"',
    'packages/x/src/a.ts:2 contains model id "gemini-9-flash-lite-tts"',
    'packages/x/src/a.ts:2 contains model id "gemini-9-flash"',
  ])
})

test('the guard catches a planted model id with file:line', () => {
  const files = new Map([['packages/x/src/a.ts', `const a = 1\nconst m = "${modelIds()[0]}"\n`]])
  expect(findModelIds(files, modelIds())).toEqual([`packages/x/src/a.ts:2 contains model id "${modelIds()[0]}"`])
})

test('the guard matches whole tokens: a model id inside a longer word is not a hit', () => {
  const files = new Map([
    [
      'packages/x/src/b.ts',
      `const tag = '<whispers>'\nconst m = 'whisper'\nconst r = 'audio.stt/whisper.x'\nconst w = whisperish`,
    ],
  ])
  expect(findModelIds(files, ['whisper'])).toEqual([
    'packages/x/src/b.ts:2 contains model id "whisper"',
    'packages/x/src/b.ts:3 contains model id "whisper"',
  ])
})

function modelIds(): string[] {
  return [
    ...new Set([
      ...Object.values(DEFAULT_ROUTES).flatMap((r) => [r.model, ...(r.fallback ? [r.fallback.model] : [])]),
      ...CLAUDE_MODELS,
    ]),
  ]
}

// Route ids are typed by module augmentation (`RouteTable`), the table is discovered at runtime: a group file without
// the augmentation would be served but missing from `RouteId`. A type cannot be listed at runtime, so the group files
// are held to the one shape whose key set is the export's by construction (`keyof typeof routes`). They import nothing
// but the schema's types and `_shared.ts`, so the table's top-level await can never wait on a cycle.
const AUGMENTATION =
  /declare module '\.\.\/schema\.ts' \{\s*interface RouteTable extends Record<keyof typeof routes, true> \{\}\s*\}/
const ALLOWED_IMPORTS = new Set(['../schema.ts', './_shared.ts'])

test('every route group exports `routes` and adds exactly its keys to RouteId, importing only the schema and _shared', () => {
  const groups = readdirSync(TABLE).filter((f) => f !== '_shared.ts')
  expect(groups.length).toBeGreaterThan(0)
  for (const file of groups) {
    const text = readFileSync(join(TABLE, file), 'utf8')
    expect({ file, exportsRoutes: /^export default routes$/m.test(text), augments: AUGMENTATION.test(text) }).toEqual({
      file,
      exportsRoutes: true,
      augments: true,
    })
    const imports = [...text.matchAll(/^import .* from '([^']+)'$/gm)].map((m) => m[1])
    expect({ file, imports: imports.filter((i) => !ALLOWED_IMPORTS.has(i ?? '')) }).toEqual({ file, imports: [] })
  }
})

// Calls that name a route by literal outside a typed `RouteId` slot (a step's untyped `options.route`) would only fail
// when the call runs. Every literal in a route position under packages/*/src must be a route the table serves.
const ROUTE_LITERAL =
  /\b(?:route|routeId): '([a-z0-9.]+)'(?!\s*\|)|\bresolve\('([a-z0-9.]+)'(?:, \w+)?\)|\bresolveRoute\('([a-z0-9.]+)'|_ROUTE(?:: RouteId)? = '([a-z0-9.]+)'/g

export function unknownRouteLiterals(files: Map<string, string>, known: Set<string>): string[] {
  const hits: string[] = []
  for (const [file, text] of files) {
    text.split('\n').forEach((line, i) => {
      for (const m of line.matchAll(ROUTE_LITERAL)) {
        const id = m.slice(1).find(Boolean) ?? ''
        if (!known.has(id)) hits.push(`${file}:${i + 1} names unknown route "${id}"`)
      }
    })
  }
  return hits
}

test('every route literal in package source is a route the table serves', () => {
  const files = new Map<string, string>()
  for (const src of readdirSync(PACKAGES)
    .map((d) => join(PACKAGES, d, 'src'))
    .filter(existsSync))
    for (const file of walk(src))
      if (/\.tsx?$/.test(file) && !TEST_FILE.match(file))
        files.set(relative(resolve(PACKAGES, '..'), file), readFileSync(file, 'utf8'))
  const known = new Set<string>(routeIds())
  expect(unknownRouteLiterals(files, known)).toEqual([])
  // The scan sees the call-time routes, not just agent lists.
  const seen = new Set(
    [...files.values()].flatMap((t) => [...t.matchAll(ROUTE_LITERAL)].map((m) => m.slice(1).find(Boolean))),
  )
  for (const id of ['review.angle.deep', 'review.ocr', 'cheap.title', 'decide']) expect(seen.has(id)).toBe(true)
})

test('the route literal scan catches a planted unknown route with file:line, and skips type unions', () => {
  const files = new Map([
    [
      'packages/x/src/a.ts',
      "const a = 1\nctx.agent('x', p, { options: { route: 'review.nope' } })\non(route: 'chat' | 'x')\n",
    ],
  ])
  expect(unknownRouteLiterals(files, new Set(routeIds()))).toEqual([
    'packages/x/src/a.ts:2 names unknown route "review.nope"',
  ])
})

// `Llm.round`, the podcast writer's tool loop, speaks only the OpenAI dialects (packages/audio/src/workflows/podcast/iu.ts):
// every podcast route must stay off the Messages wire.
test('no podcast route is on the anthropic wire or a Claude model', () => {
  const ids = routeIds().filter((id) => id.startsWith('podcast.'))
  expect(ids.length).toBeGreaterThan(0)
  for (const id of ids) {
    const route = resolveRoute(id, {})
    expect({ id, wire: route.wire, claude: route.model.startsWith('claude-') }).toEqual({
      id,
      wire: expect.not.stringMatching(/^anthropic$/),
      claude: false,
    })
  }
})

// The gateway refuses a Claude route with 402 when the credit is gone, so a fallback is the only way the call survives,
// and it must never land on a Claude model: IU's Claude is exactly what a drained credit must not reach.
test('a Claude route has a GPT fallback; nothing on the chat wire or OpenCode falls back onto Claude', () => {
  const claude = /^claude-/
  const gpt = expect.stringMatching(/^gpt-/)
  for (const id of routeIds()) {
    const route = resolveRoute(id, {})
    // a native Messages call is a Claude model with a GPT fallback on another wire
    if (route.wire === 'anthropic') {
      expect({ id, model: route.model }).toEqual({ id, model: expect.stringMatching(claude) })
      expect({ id, fallback: route.fallback?.model }).toEqual({ id, fallback: gpt })
    }
    // an OpenCode step on Claude is refused with 402 the same way, and moves to a GPT step
    if (route.wire === 'opencode' && claude.test(route.model)) {
      expect({ id, fallback: route.fallback?.model }).toEqual({ id, fallback: gpt })
    }
    // a `claude-` single call on the chat wire would reach IU's Claude, not the credit
    if (route.wire === 'iu-openai') expect({ id, claude: claude.test(route.model) }).toEqual({ id, claude: false })
    if (route.wire === 'iu-openai' || route.wire === 'opencode')
      expect({ id, claude: claude.test(route.fallback?.model ?? '') }).toEqual({ id, claude: false })
    expect({ id, wire: route.fallback?.wire }).not.toEqual({ id, wire: 'anthropic' })
  }
})

// A text route takes its model from a tier or a named constant in `_shared.ts`, never from a `model:` literal in its group
// file. The media routes below are the only literals left: voices, transcription, image and Replicate models, which no
// tier covers. A new entry here is a decision, not a convenience.
const MEDIA_ROUTES = new Set([
  'audio.tts.gemini-flash-lite', // Gemini TTS
  'audio.tts.gemini-flash', // Gemini TTS
  'audio.tts.elevenlabs-flash', // Replicate TTS
  'audio.tts.elevenlabs-turbo', // Replicate TTS
  'audio.tts.elevenlabs-v3', // Replicate TTS
  'audio.stt.voxtral-mini', // STT
  'audio.stt.voxtral-small', // STT
  'audio.stt.openai', // STT
  'audio.stt.openai-4o', // STT
  'audio.stt.openai-4o-mini', // STT
  'audio.stt.openai-legacy', // STT
  'image.flare', // image generation
  'image.sunburst', // image generation
  'image.cutout.recraft', // Replicate
  'image.cutout.bria', // Replicate
  'image.upscale', // Replicate
  'image.vectorize', // Replicate
])

/**
 * Every `model:` literal in a group file that sits in a route outside `media`, as `file:line`. A route's entry starts at
 * its two-space-indented key (`'audio.tts.prep': ...` or `decide: ...`); a literal belongs to the entry above it.
 */
function textModelLiterals(file: string, text: string, media: Set<string>): string[] {
  const hits: string[] = []
  let route = ''
  text.split('\n').forEach((line, i) => {
    route = /^ {2}(?:'([a-z0-9.-]+)'|([a-z]+)):/.exec(line)?.slice(1).find(Boolean) ?? route
    if (/\bmodel:\s*['"`]/.test(line) && !media.has(route))
      hits.push(`${file}:${i + 1} names a model literal in text route "${route}": ${line.trim()}`)
  })
  return hits
}

test('a text route takes its model from a tier or a _shared.ts constant: no `model:` literal in its group file', () => {
  // Route discovery skips `*.test.ts` too (registry.ts), so those are no group files.
  const hits = readdirSync(TABLE)
    .filter((f) => f !== '_shared.ts' && f !== 'claude.ts' && !f.endsWith('.test.ts'))
    .flatMap((f) =>
      textModelLiterals(`packages/routes/src/table/${f}`, readFileSync(join(TABLE, f), 'utf8'), MEDIA_ROUTES),
    )
  expect(hits).toEqual([])
  for (const id of MEDIA_ROUTES) expect(routeIds() as string[]).toContain(id)
})

test('the literal scan catches a planted model literal in a text route with file:line, and skips a media route', () => {
  const text =
    "const routes = {\n  'a.media': {\n    wire: 'iu-openai',\n    model: 'm1',\n  },\n  'a.text': { wire: 'anthropic', model: 'm2' },\n}\n"
  expect(textModelLiterals('x.ts', text, new Set(['a.media']))).toEqual([
    `x.ts:6 names a model literal in text route "a.text": 'a.text': { wire: 'anthropic', model: 'm2' },`,
  ])
})

// Every route on a Claude model spreads a tier: model, effort, rate and fallback are those of the tier's step kind (a
// single call on the `anthropic` wire, an agent step on `opencode`). Overrides are the output limit, and for
// `image.enhance` the effort, with its fallback raised to the same effort.
const EFFORT_OVERRIDES = new Set(['image.enhance'])
const CLAUDE_TIERS = { FAST, EASY, HARD }
type StepShape = { model: string; effort: string; rate: object; fallback: object }

test('every route on a Claude model spreads a tier', () => {
  const claude = routeIds().filter((id) => resolveRoute(id, {}).model.startsWith('claude-'))
  expect(claude.length).toBeGreaterThan(0)
  for (const id of claude) {
    const route = resolveRoute(id, {})
    expect({ id, wire: route.wire }).toEqual({ id, wire: expect.stringMatching(/^(anthropic|opencode)$/) })
    const kind = route.wire === 'anthropic' ? 'call' : 'agent'
    const spreads = Object.values(CLAUDE_TIERS).some((tier) => {
      const step = (tier as Partial<Record<string, StepShape>>)[kind]
      if (!step) return false
      const raised = EFFORT_OVERRIDES.has(id) && route.effort !== step.effort
      const expected = raised
        ? { ...step, effort: route.effort, fallback: { ...step.fallback, effort: route.effort } }
        : step
      return Bun.deepEquals(
        { model: route.model, effort: route.effort, rate: route.rate, fallback: route.fallback },
        { model: expected.model, effort: expected.effort, rate: expected.rate, fallback: expected.fallback },
      )
    })
    expect({ id, spreadsATier: spreads }).toEqual({ id, spreadsATier: true })
  }
})
