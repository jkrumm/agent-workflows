// scripts/deploy.sh's door-tokens handling, run by the real zsh: the file is created with a hermes and a studio token, a
// file that exists gains a studio line only when it has none (its other lines untouched, mode 0600, no token printed),
// and the release's own parser refuses a bad file before anything is stopped.
import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readDoorTokens } from '../src/door-tokens.ts'

const ROOT = join(import.meta.dir, '../../..')
const ZSH = Bun.which('zsh')
const HERMES = 'hermes-token-0123456789abcdef-0123456789'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A fake HOME whose data dir holds `content` as door-tokens (none: no file), and `run` for deploy.sh's functions. */
function setup(content?: string, mode = 0o600) {
  const home = mkdtempSync(join(tmpdir(), 'agw-door-tokens-'))
  dirs.push(home)
  const data = join(home, '.agent-workflows', 'data')
  mkdirSync(data, { recursive: true })
  const file = join(data, 'door-tokens')
  if (content !== undefined) {
    writeFileSync(file, content)
    chmodSync(file, mode)
  }
  const run = (body: string) => {
    if (!ZSH) throw new Error('zsh is not on PATH: scripts/deploy.sh needs it (CI installs it in ci.yml)')
    const fns = readFileSync(join(ROOT, 'scripts', 'deploy.sh'), 'utf8').replace(/\nmain\s*$/, '\n')
    const proc = Bun.spawnSync([ZSH, '-c', `${fns}\n${body}`], {
      env: { PATH: process.env.PATH ?? '', HOME: home },
    })
    return { code: proc.exitCode, out: proc.stdout.toString(), err: proc.stderr.toString() }
  }
  return { file, run }
}

const mode = (file: string) => statSync(file).mode & 0o777

describe('ensure_door_tokens', () => {
  test('no file: created at 0600 with a hermes and a studio token, distinct, valid, never printed', () => {
    const t = setup()
    const result = t.run('ensure_door_tokens')
    expect(result.code).toBe(0)
    expect(mode(t.file)).toBe(0o600)
    const tokens = readDoorTokens(t.file)
    expect([...tokens.keys()]).toEqual(['hermes', 'studio'])
    expect(new Set(tokens.values()).size).toBe(2)
    for (const token of tokens.values()) {
      expect(token).toMatch(/^[0-9a-f]{64}$/)
      expect(result.out + result.err).not.toContain(token)
    }
  })

  test('a file with only hermes gains a studio line: the existing bytes are kept, even without a trailing newline', () => {
    for (const existing of [`hermes=${HERMES}\n`, `hermes=${HERMES}`, `# callers\nhermes=${HERMES}\n\n`]) {
      const t = setup(existing)
      const result = t.run('ensure_door_tokens')
      expect(result.code).toBe(0)
      const after = readFileSync(t.file, 'utf8')
      expect(after.startsWith(existing)).toBe(true)
      expect(mode(t.file)).toBe(0o600)
      const tokens = readDoorTokens(t.file)
      expect(tokens.get('hermes')).toBe(HERMES)
      expect(tokens.get('studio')).toMatch(/^[0-9a-f]{64}$/)
      expect(result.out + result.err).not.toContain(tokens.get('studio') as string)
    }
  })

  test('a studio caller that exists is never replaced, however it is spelled; a commented one does not count', () => {
    const studio = 'studio-token-0123456789abcdef-0123456789'
    for (const existing of [`hermes=${HERMES}\nstudio=${studio}\n`, `studio = ${studio}\n`]) {
      const t = setup(existing)
      expect(t.run('ensure_door_tokens').code).toBe(0)
      expect(readFileSync(t.file, 'utf8')).toBe(existing)
    }
    const commented = setup(`hermes=${HERMES}\n# studio=${studio}\n`)
    expect(commented.run('ensure_door_tokens').code).toBe(0)
    expect(readDoorTokens(commented.file).get('studio')).toMatch(/^[0-9a-f]{64}$/)
  })

  test('a file that is not at 0600 is left exactly as it is, for the check to refuse', () => {
    const t = setup(`hermes=${HERMES}\n`, 0o644)
    expect(t.run('ensure_door_tokens').code).toBe(0)
    expect(readFileSync(t.file, 'utf8')).toBe(`hermes=${HERMES}\n`)
    expect(mode(t.file)).toBe(0o644)
  })
})

describe('check_door_tokens', () => {
  test('the release parser passes a good file and refuses a bad one naming file and line, never a token', () => {
    const good = setup(`hermes=${HERMES}\nstudio=studio-token-0123456789abcdef-0123456789\n`)
    expect(good.run(`check_door_tokens ${ROOT}`).code).toBe(0)

    const wide = setup(`hermes=${HERMES}\n`, 0o644)
    const refused = wide.run(`check_door_tokens ${ROOT}`)
    expect(refused.code).toBe(1)
    expect(refused.err).toContain('the door tokens are unusable')
    expect(refused.err).toContain(wide.file)
    expect(refused.err).toContain('nothing was stopped')

    const malformed = setup(`hermes=${HERMES}\nstudio token\n`)
    const bad = malformed.run(`check_door_tokens ${ROOT}`)
    expect(bad.code).toBe(1)
    expect(bad.err).toContain(`${malformed.file}:2: expected name=token`)
    expect(bad.err).not.toContain(HERMES)
  })
})
