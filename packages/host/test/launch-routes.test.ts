import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

// The route override block of scripts/launch.sh, run in /bin/sh the way the secrets-run child runs it (fake HOME).
const launch = await Bun.file(join(import.meta.dir, '../../../scripts/launch.sh')).text()
const BLOCK = launch.split('# >>> routes-override\n')[1]?.split('  # <<< routes-override')[0] ?? ''
const ROOT = join(import.meta.dir, '../../..') // launch.sh runs from the release root: the validator import resolves from there
const PATH = `${dirname(process.execPath)}:/usr/bin:/bin`

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

type File = { content: string; mode?: number } | { symlinkTo: string } | { directory: true }

function run(file: File | null, env: Record<string, string> = {}, block = BLOCK, cwd = ROOT) {
  const home = mkdtempSync(join(tmpdir(), 'agw-routes-override-'))
  dirs.push(home)
  if (file) {
    mkdirSync(join(home, '.config/agw'), { recursive: true })
    const path = join(home, '.config/agw/routes.json')
    if ('directory' in file) {
      mkdirSync(path)
    } else if ('symlinkTo' in file) {
      writeFileSync(join(home, 'target.json'), file.symlinkTo)
      symlinkSync(join(home, 'target.json'), path)
    } else {
      writeFileSync(path, file.content)
      chmodSync(path, file.mode ?? 0o600)
    }
  }
  const script = `${block}\nprintf '%s' "\${AGW_ROUTES-unset}"`
  const proc = Bun.spawnSync(['/bin/sh', '-c', script], { cwd, env: { PATH, HOME: home, ...env } })
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

  test('malformed JSON refuses with 78: the file is named, the parser message and the content are not printed', () => {
    const r = run({ content: `{"review.angle": {"model": "${SECRET_MODEL}"` })
    expect(r.code).toBe(78)
    expect(r.err).toContain('routes.json')
    expect(r.err).toContain('not valid JSON')
    expect(r.err).not.toContain(SECRET_MODEL)
    expect(run({ content: '{"check": leakysecret}' }).err).not.toContain('leakysecret')
    expect(r.out).toBe('')
  })

  test('an unknown route id and a bad spec refuse with 78, naming the id and not the value', () => {
    const unknown = run({ content: JSON.stringify({ 'no.such': { model: SECRET_MODEL } }) }, { AGW_ROUTES: '{}' })
    expect(unknown.code).toBe(78)
    expect(unknown.err).toContain('"no.such"')
    expect(unknown.err).not.toContain(SECRET_MODEL)
    expect(unknown.out).toBe('')
    const bad = run({ content: JSON.stringify({ 'review.angle': { effort: 'leakysecret' } }) })
    expect(bad.code).toBe(78)
    expect(bad.err).toContain('review.angle')
    expect(bad.err).not.toContain('leakysecret')
    // one good patch does not excuse a later bad one
    expect(run({ content: JSON.stringify({ check: { effort: 'low' }, nope: {} }) }).code).toBe(78)
  })

  test('JSON that is not an object, and an empty file, refuse with 78', () => {
    for (const content of ['[]', '"x"', 'null', '42', '', '  \n']) {
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

  test('a directory at the path refuses with 78', () => {
    const r = run({ directory: true })
    expect(r.code).toBe(78)
    expect(r.err).toContain('regular file')
    expect(r.out).toBe('')
  })

  // chown needs root, so the ownership check runs for real against a file this user does not own: only the path its
  // `-O` test names is swapped for a root-owned system file, with a mode that would pass every other check.
  test.skipIf(process.getuid?.() === 0)('a file owned by another user refuses with 78', () => {
    const owned = '[ -O "$ROUTES_OVERRIDE" ]'
    expect(BLOCK).toContain(owned)
    const r = run({ content: VALID }, {}, BLOCK.replace(owned, '[ -O /etc/hosts ]'))
    expect(r.code).toBe(78)
    expect(r.err).toContain('owned by the user')
    expect(r.out).toBe('')
  })

  test('a validator that cannot run refuses with 78 and says so, with none of bun output in the message', () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'agw-routes-nocwd-'))
    dirs.push(elsewhere)
    const r = run({ content: VALID }, {}, BLOCK, elsewhere)
    expect(r.code).toBe(78)
    expect(r.err).toContain('validator did not run')
    expect(r.err).not.toContain(SECRET_MODEL)
    expect(r.out).toBe('')
  })
})
