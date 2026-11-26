import { expect, test } from 'bun:test'
import { join } from 'node:path'

// A listener without a hostname binds the wildcard address. On macOS its port can be one another process already holds on
// 127.0.0.1, and that process then takes the loopback requests: a red test now and then, on a busy machine only.
const packages = join(import.meta.dir, '..', '..')
// An aliased `serve` or `listen` is not seen; no package imports them that way.
const CALL = /\bBun\.(?:serve|listen)(?:<[^()]*>)?\(/g

/** The options object's own text in a call whose arguments start at `from`: what handlers and nested values hold is left out. */
function ownKeys(source: string, from: number): string {
  let depth = 0
  let own = ''
  for (let i = from; i < source.length && depth >= 0; i++) {
    const char = source[i] as string
    if ('([{'.includes(char)) depth++
    else if (')]}'.includes(char)) depth--
    else if (depth === 1) own += char
  }
  return own
}

test('every listener in packages names the address it binds', async () => {
  const wildcard: string[] = []
  let calls = 0
  for await (const path of new Bun.Glob('*/{src,test}/**/*.{ts,tsx}').scan({ cwd: packages })) {
    const source = await Bun.file(join(packages, path)).text()
    for (const match of source.matchAll(CALL)) {
      calls++
      const body = source.slice(match.index + match[0].length).replace(/^\s*\/\/.*$/gm, '')
      // The key itself, written out or as shorthand.
      if (/(?<![.\w])(hostname|unix)\s*(:|,|\n|$)/.test(ownKeys(body, 0))) continue
      wildcard.push(`${path}:${source.slice(0, match.index).split('\n').length}`)
    }
  }
  expect(calls).toBeGreaterThan(0)
  expect(wildcard).toEqual([])
})
