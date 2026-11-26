import { expect, test } from 'bun:test'
import { join } from 'node:path'

// A listener without a hostname binds the wildcard address. On macOS its port can be one another process already holds on
// 127.0.0.1, and that process then takes the loopback requests: a red test now and then, on a busy machine only.
const packages = join(import.meta.dir, '..', '..')
const CALL = /\bBun\.(?:serve|listen)\(/g

/** The text between a call's opening parenthesis (just before `from`) and its closing one. */
function argumentsFrom(source: string, from: number): string {
  let depth = 1
  let i = from
  for (; i < source.length && depth > 0; i++) {
    if (source[i] === '(') depth++
    if (source[i] === ')') depth--
  }
  return source.slice(from, i - 1)
}

test('every listener in packages names the address it binds', async () => {
  const wildcard: string[] = []
  let calls = 0
  for await (const path of new Bun.Glob('*/{src,test}/**/*.{ts,tsx}').scan({ cwd: packages })) {
    const source = await Bun.file(join(packages, path)).text()
    for (const match of source.matchAll(CALL)) {
      calls++
      const options = argumentsFrom(source, match.index + match[0].length).replace(/\/\/.*$/gm, '')
      // The key itself, written out or as shorthand: `url.hostname` in a handler does not count.
      if (/(?<!\.)\b(hostname|unix)\s*[:,}]/.test(options)) continue
      wildcard.push(`${path}:${source.slice(0, match.index).split('\n').length}`)
    }
  }
  expect(calls).toBeGreaterThan(0)
  expect(wildcard).toEqual([])
})
