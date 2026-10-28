import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

// The route override block of scripts/launch.sh, run in /bin/sh the way the secrets-run child runs it (fake HOME).
const launch = await Bun.file(join(import.meta.dir, '../../../scripts/launch.sh')).text()
const BLOCK = launch.split('# >>> routes-override\n')[1]?.split('  # <<< routes-override')[0] ?? ''
const PATH = `${dirname(process.execPath)}:/usr/bin:/bin`

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

type File = { content: string; mode?: number } | { symlinkTo: string }

function run(file: File | null, env: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'agw-routes-override-'))
  dirs.push(home)
  if (file) {
    mkdirSync(join(home, '.config/agw'), { recursive: true })
    const path = join(home, '.config/agw/routes.json')
    if ('symlinkTo' in file) {
      writeFileSync(join(home, 'target.json'), file.symlinkTo)
      symlinkSync(join(home, 'target.json'), path)
    } else {
      writeFileSync(path, file.content)
      chmodSync(path, file.mode ?? 0o600)
    }
  }
  const script = `${BLOCK}\nprintf '%s' "\${AGW_ROUTES-unset}"`
  const proc = Bun.spawnSync(['/bin/sh', '-c', script], { env: { PATH, HOME: home, ...env } })
  return { code: proc.exitCode, out: proc.stdout.toString(), err: proc.stderr.toString() }
}

const SECRET_MODEL = 'secret-model-name'
const VALID = JSON.stringify({ 'review.angle': { model: SECRET_MODEL }, 'cheap.title': { effort: 'low' } })

describe('launch.sh route override', () => {
  test('the block is found', () => {
    expect(BLOCK).toContain('routes.json')
  })

  test('absent file: the environment is untouched', () => {
    expect(run(null)).toMatchObject({ code: 0, out: 'unset', err: '' })
    expect(run(null, { AGW_ROUTES: '{"a":{}}' })).toMatchObject({ code: 0, out: '{"a":{}}', err: '' })
  })

  test('a valid file exports its content, logging the route ids and not the models', () => {
    const r = run({ content: VALID })
    expect(r.code).toBe(0)
    expect(r.out).toBe(VALID)
    expect(r.err).toContain('review.angle,cheap.title')
    expect(r.err).not.toContain(SECRET_MODEL)
  })

  test('the file wins over an AGW_ROUTES already in the environment', () => {
    expect(run({ content: VALID }, { AGW_ROUTES: '{"other":{}}' }).out).toBe(VALID)
  })

  test('a file with a trailing newline and an empty object are accepted', () => {
    expect(run({ content: `${VALID}\n` })).toMatchObject({ code: 0, out: VALID })
    expect(run({ content: '{}' })).toMatchObject({ code: 0, out: '{}' })
  })

  test('malformed JSON refuses with 78, naming the file and never its content', () => {
    const r = run({ content: `{"review.angle": {"model": "${SECRET_MODEL}"` })
    expect(r.code).toBe(78)
    expect(r.err).toContain('routes.json')
    expect(r.err).not.toContain(SECRET_MODEL)
    expect(r.out).toBe('')
  })

  test('JSON that is not an object refuses with 78', () => {
    for (const content of ['[]', '"x"', 'null', '42', '']) {
      expect(run({ content }, { AGW_ROUTES: '{"keep":{}}' })).toMatchObject({ code: 78, out: '' })
    }
  })

  test('a group- or world-writable file refuses with 78', () => {
    for (const mode of [0o620, 0o602, 0o666]) {
      const r = run({ content: VALID, mode })
      expect(r.code).toBe(78)
      expect(r.err).toContain('writable')
      expect(r.out).toBe('')
    }
  })

  test('a read-only group or world mode is accepted', () => {
    expect(run({ content: VALID, mode: 0o644 })).toMatchObject({ code: 0, out: VALID })
  })

  test('a symlink refuses with 78 even when its target is valid', () => {
    const r = run({ symlinkTo: VALID })
    expect(r.code).toBe(78)
    expect(r.err).toContain('regular file')
    expect(r.out).toBe('')
  })
})
