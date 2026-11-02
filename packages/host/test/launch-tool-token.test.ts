import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The gateway tool-token block of scripts/launch.sh, run in /bin/sh the way the secrets-run child runs it (fake HOME,
// fake tokens): the host gets the agw-opencode door token as AGW_GATEWAY_TOOL_TOKEN, the audio process gets nothing.
const launch = await Bun.file(join(import.meta.dir, '../../../scripts/launch.sh')).text()
const BLOCK = launch.split('# >>> gateway-tool-token\n')[1]?.split('  # <<< gateway-tool-token')[0] ?? ''
const TOKEN = 'agw-opencode-token-0123456789abcdef-0123'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function run(content: string | null, options: { process?: string; env?: Record<string, string> } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'agw-tool-token-'))
  dirs.push(home)
  const file = join(home, '.agent-workflows/data/door-tokens')
  if (content !== null) {
    mkdirSync(join(home, '.agent-workflows/data'), { recursive: true })
    writeFileSync(file, content)
    chmodSync(file, 0o600)
  }
  const script = `${BLOCK}\nprintf '%s' "\${AGW_GATEWAY_TOOL_TOKEN-unset}"`
  const env = { PATH: '/usr/bin:/bin', HOME: home, AGW_LAUNCH_PROCESS: options.process ?? 'host', ...options.env }
  const proc = Bun.spawnSync(['/bin/sh', '-c', script], { env })
  return { code: proc.exitCode, out: proc.stdout.toString(), err: proc.stderr.toString(), file, home }
}

describe('launch.sh gateway tool token', () => {
  test('the block is found', () => {
    expect(BLOCK).toContain('agw-opencode')
    expect(launch).not.toContain('iu.env')
    expect(launch).not.toContain('IU_API_KEY')
  })

  test('the host gets the agw-opencode token, and only that line is read', () => {
    const r = run(`hermes=${'h'.repeat(64)}\nagw-opencode=${TOKEN}\nstudio=${'s'.repeat(64)}\n`)
    expect(r).toMatchObject({ code: 0, out: TOKEN, err: '' })
  })

  test('whitespace around name and token, CRLF endings and a last line without a newline are accepted', () => {
    expect(run(`hermes=${'h'.repeat(64)}\r\n  agw-opencode =  ${TOKEN}  \r\n`).out).toBe(TOKEN)
    expect(run(`agw-opencode=${TOKEN}`).out).toBe(TOKEN)
  })

  test('a commented line or a caller whose name merely contains agw-opencode does not count', () => {
    for (const content of [`# agw-opencode=${TOKEN}\n`, `x-agw-opencode=${TOKEN}\n`, `agw-opencode-old=${TOKEN}\n`]) {
      const r = run(content)
      expect(r.code).toBe(78)
      expect(r.out).toBe('')
    }
  })

  test('AGW_DOOR_CALLERS_FILE (what the plist sets) wins over the default path', () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'agw-tool-token-file-'))
    dirs.push(elsewhere)
    writeFileSync(join(elsewhere, 'tokens'), `agw-opencode=${TOKEN}\n`)
    const r = run(null, { env: { AGW_DOOR_CALLERS_FILE: join(elsewhere, 'tokens') } })
    expect(r).toMatchObject({ code: 0, out: TOKEN })
  })

  test('a missing file, a missing line or an empty token refuse with 78, naming the file and the caller, never a value', () => {
    const missing = run(null)
    expect(missing.code).toBe(78)
    expect(missing.err).toContain(missing.file)
    expect(missing.err).toContain('agw-opencode')

    const hermes = 'hermes-secret-token-0123456789abcdef-0123'
    for (const content of [`hermes=${hermes}\n`, `hermes=${hermes}\nagw-opencode=\n`, `agw-opencode=   \n`]) {
      const r = run(content)
      expect(r.code).toBe(78)
      expect(r.out).toBe('')
      expect(r.err).toContain(r.file)
      expect(r.err).toContain('agw-opencode')
      expect(r.err).not.toContain(hermes)
    }
  })

  test('the audio process never reads the file and never gets the token', () => {
    expect(run(`agw-opencode=${TOKEN}\n`, { process: 'audio' })).toMatchObject({ code: 0, out: 'unset', err: '' })
    expect(run(null, { process: 'audio' })).toMatchObject({ code: 0, out: 'unset', err: '' })
  })

  test('the launcher names the process for the child', () => {
    expect(launch).toContain('AGW_LAUNCH_PROCESS="$PROCESS"')
    expect(launch).toContain('export AGW_LAUNCH_ENTRY AGW_LAUNCH_PROCESS')
  })
})
