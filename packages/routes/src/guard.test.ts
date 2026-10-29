import { expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { DEFAULT_ROUTES } from './index.ts'

// The home-of-model-ids rule: no source outside `packages/routes/src/table/` names a model that the table names. The
// routes package's own tests may (they pin what the table says).
const PACKAGES = resolve(import.meta.dir, '../..')
const OWN = 'routes'
const TABLE = join(import.meta.dir, 'table')

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
    .concat([...walk(import.meta.dir)].filter((file) => !file.startsWith(`${TABLE}/`) && !file.endsWith('.test.ts')))
}

export function findModelIds(files: Map<string, string>, ids: string[]): string[] {
  const hits: string[] = []
  for (const [file, text] of files) {
    text.split('\n').forEach((line, i) => {
      for (const id of ids) if (line.includes(id)) hits.push(`${file}:${i + 1} contains model id "${id}"`)
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

test('the guard catches a planted model id with file:line', () => {
  const files = new Map([['packages/x/src/a.ts', `const a = 1\nconst m = "${modelIds()[0]}"\n`]])
  expect(findModelIds(files, modelIds())).toEqual([`packages/x/src/a.ts:2 contains model id "${modelIds()[0]}"`])
})

function modelIds(): string[] {
  return [
    ...new Set(Object.values(DEFAULT_ROUTES).flatMap((r) => [r.model, ...(r.fallback ? [r.fallback.model] : [])])),
  ]
}
