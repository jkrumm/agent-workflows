import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The IU override block of scripts/launch.sh, run in /bin/sh the way the secrets-run child runs it (fake HOME, fake keys).
const launch = await Bun.file(join(import.meta.dir, '../../../scripts/launch.sh')).text()
const BLOCK = launch.split('# >>> iu-override\n')[1]?.split('  # <<< iu-override')[0] ?? ''

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function run(file: { content: string; mode?: number } | null, env: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'agw-iu-override-'))
  dirs.push(home)
  if (file) {
    mkdirSync(join(home, '.config/agw'), { recursive: true })
    const path = join(home, '.config/agw/iu.env')
    writeFileSync(path, file.content)
    chmodSync(path, file.mode ?? 0o600)
  }
  const script = `${BLOCK}\nprintf '%s|%s' "\${IU_API_KEY-unset}" "\${IU_KEY_ID-unset}"`
  const proc = Bun.spawnSync(['/bin/sh', '-c', script], { env: { PATH: '/usr/bin:/bin', HOME: home, ...env } })
  return { code: proc.exitCode, out: proc.stdout.toString(), err: proc.stderr.toString() }
}

describe('launch.sh IU override', () => {
  test('the block is found', () => {
    expect(BLOCK).toContain('iu.env')
  })

  test('absent file: the environment is untouched', () => {
    expect(run(null, { IU_API_KEY: 'tpl-key', IU_KEY_ID: 'personal' })).toMatchObject({
      code: 0,
      out: 'tpl-key|personal',
      err: '',
    })
  })

  test('both names override the template values', () => {
    const r = run(
      { content: '# team key\nexport IU_API_KEY="team-key"\nIU_KEY_ID=athena-team\n' },
      { IU_API_KEY: 'tpl-key', IU_KEY_ID: 'personal' },
    )
    expect(r).toMatchObject({ code: 0, out: 'team-key|athena-team', err: '' })
  })

  test('single quotes, double quotes and CRLF line endings are accepted', () => {
    const r = run({ content: 'IU_API_KEY=\'team-key\'\r\nIU_KEY_ID="athena-team"\r\n' })
    expect(r).toMatchObject({ code: 0, out: 'team-key|athena-team', err: '' })
  })

  test('an unknown label or an empty key refuses with 78, naming the variable and not the value', () => {
    const label = run({ content: 'IU_API_KEY=k\nIU_KEY_ID=sk-not-a-label\n' })
    expect(label.code).toBe(78)
    expect(label.err).toContain('IU_KEY_ID')
    expect(label.err).not.toContain('sk-not-a-label')
    const key = run({ content: 'IU_API_KEY=\nIU_KEY_ID=athena-team\n' })
    expect(key.code).toBe(78)
    expect(key.err).toContain('IU_API_KEY')
  })

  test('any other line is ignored with a warning that names the variable, never a value', () => {
    const r = run(
      { content: 'IU_API_KEY=team-key\nIU_KEY_ID=athena-team\nGITHUB_TOKEN=secret-value\n=oops-value\nnoequals\n' },
      { IU_API_KEY: 'tpl-key' },
    )
    expect(r.code).toBe(0)
    expect(r.out).toBe('team-key|athena-team')
    expect(r.err).toContain('GITHUB_TOKEN')
    expect(r.err).not.toContain('secret-value')
    expect(r.err).not.toContain('oops-value')
    expect(r.err).not.toContain('team-key')
  })

  test('a mode other than 0600 refuses with 78 and says why', () => {
    const r = run({ content: 'IU_API_KEY=k\nIU_KEY_ID=athena-team\n', mode: 0o640 }, { IU_API_KEY: 'tpl-key' })
    expect(r.code).toBe(78)
    expect(r.err).toContain('0600')
    expect(r.out).toBe('')
  })

  test('the label goes with the key: one without the other refuses', () => {
    expect(run({ content: 'IU_API_KEY=k\n' }).code).toBe(78)
    expect(run({ content: 'IU_KEY_ID=athena-team\n' }).code).toBe(78)
  })
})
