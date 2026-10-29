import { expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { DEFAULT_ROUTES, routeIds } from './index.ts'

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
    ...new Set(Object.values(DEFAULT_ROUTES).flatMap((r) => [r.model, ...(r.fallback ? [r.fallback.model] : [])])),
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
  /\b(?:route|routeId): '([a-z0-9.]+)'(?!\s*\|)|\bresolve\(deps, '([a-z0-9.]+)'\)|\bresolveRoute\('([a-z0-9.]+)'|_ROUTE(?:: RouteId)? = '([a-z0-9.]+)'/g

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
