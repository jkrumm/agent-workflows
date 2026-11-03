import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createExec, helperEnv, networkEnv, tail } from '../src/process.ts'
import { expectDead } from './support/process.ts'

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'agw-process-')))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(['git', ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.com',
    },
  })
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`)
  return r.stdout.toString()
}

function repo(files: Record<string, string>) {
  const dir = join(scratch, 'repo')
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q', '-b', 'main')
  for (const [path, content] of Object.entries(files)) writeFileSync(join(dir, path), content)
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'base')
  return dir
}

describe('helper environment', () => {
  const source = {
    PATH: process.env.PATH,
    HOME: '/home/x',
    LC_ALL: 'C',
    TERM: 'xterm',
    AGW_API_SECRET: 'api-secret-value',
    IU_API_KEY: 'iu-key-value',
    IU_BASE_URL: 'https://iu.example.com/anthropic',
    ARGO_API_SECRET: 'argo-value',
    AGW_PG_PASSWORD: 'pg-value',
    GIT_CONFIG_GLOBAL: '/etc/headless-gitconfig',
    GIT_TOKEN: 'git-token-value',
    GIT_ASKPASS: '/bin/askpass',
    GIT_SSH_COMMAND: 'ssh -i key',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.sshCommand',
    GIT_CONFIG_VALUE_0: 'sh -c evil',
    GIT_EXTERNAL_DIFF: '/bin/evil',
    GIT_AUTHOR_NAME: 'Reviewer',
  }

  test('an allowlist: only the named GIT_* paths, no host secret, nothing that names a program or redirects git', () => {
    const env = helperEnv({
      ...source,
      GIT_DIR: '/elsewhere/.git',
      GIT_WORK_TREE: '/elsewhere',
      GIT_CONFIG_SYSTEM: '/etc/sys',
    })
    expect(Object.keys(env).sort()).toEqual(
      [
        'GIT_CONFIG_GLOBAL',
        'GIT_CONFIG_SYSTEM',
        'GIT_OPTIONAL_LOCKS',
        'GIT_TERMINAL_PROMPT',
        'HOME',
        'LC_ALL',
        'PATH',
        'TERM',
      ].sort(),
    )
    expect(JSON.stringify(env)).not.toMatch(
      /secret-value|iu-key-value|argo-value|pg-value|git-token|evil|askpass|elsewhere/,
    )
  })

  test('GIT_DIR in the host env does not leak: git still works in the directory it is given', async () => {
    const dir = repo({ 'a.ts': 'a\n' })
    const run = createExec({
      ...source,
      GIT_DIR: join(scratch, 'nowhere', '.git'),
      GIT_WORK_TREE: join(scratch, 'nowhere'),
    })
    const env = await run(['env'], { cwd: dir, timeoutMs: 10_000 })
    expect(env.stdout).not.toContain('GIT_DIR=')
    expect(env.stdout).not.toContain('GIT_WORK_TREE=')
    const top = await run(['git', 'rev-parse', '--show-toplevel'], { cwd: dir, timeoutMs: 10_000 })
    expect(top.code).toBe(0)
    expect(realpathSync(top.stdout.trim())).toBe(dir)
  })

  test('SSH_AUTH_SOCK and XDG_CONFIG_HOME are for the remote calls only: networkEnv, never helperEnv', () => {
    const withSocket = { ...source, SSH_AUTH_SOCK: '/tmp/agent.sock', XDG_CONFIG_HOME: '/home/x/.config' }
    expect(networkEnv(withSocket)).toEqual({ SSH_AUTH_SOCK: '/tmp/agent.sock', XDG_CONFIG_HOME: '/home/x/.config' })
    expect(networkEnv(source)).toEqual({})
    expect(helperEnv(withSocket)).not.toHaveProperty('SSH_AUTH_SOCK')
    expect(helperEnv(withSocket)).not.toHaveProperty('XDG_CONFIG_HOME')
  })

  test('a helper process really does not see them (ports.env is what it is built from)', async () => {
    const run = createExec(source)
    const r = await run(['env'], { cwd: scratch, timeoutMs: 10_000 })
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('HOME=/home/x')
    for (const name of [
      'AGW_API_SECRET',
      'IU_API_KEY',
      'IU_BASE_URL',
      'ARGO_API_SECRET',
      'AGW_PG_PASSWORD',
      'GIT_TOKEN',
      'GIT_CONFIG_COUNT',
      'GIT_EXTERNAL_DIFF',
    ]) {
      expect(r.stdout).not.toContain(`${name}=`)
    }
    // a test env without a PATH still finds git
    const bare = await createExec({})(['git', '--version'], { cwd: scratch, timeoutMs: 10_000 })
    expect(bare.code).toBe(0)
  })

  test('the process env is not read once an env is given', async () => {
    process.env.AGW_LEAK_PROBE = 'leaked'
    try {
      const r = await createExec({ PATH: process.env.PATH })(['env'], { cwd: scratch, timeoutMs: 10_000 })
      expect(r.stdout).not.toContain('AGW_LEAK_PROBE')
    } finally {
      delete process.env.AGW_LEAK_PROBE
    }
  })
})

describe('process groups', () => {
  test('a timeout kills the helper and its grandchildren, which hold the pipes', async () => {
    // sh -> sh -> sleep: `pkill -P` of the first sh would stop at the inner sh and leave the sleep.
    const script = 'sh -c "sleep 30 & echo \\$!; wait" & wait'
    const r = await createExec({ PATH: process.env.PATH })(['sh', '-c', script], { cwd: scratch, timeoutMs: 400 })
    expect(r.timedOut).toBe(true)
    const pid = Number(r.stdout.trim().split('\n')[0])
    expect(pid).toBeGreaterThan(1)
    await expectDead(pid)
  })

  test('an abort does the same', async () => {
    const controller = new AbortController()
    const script = 'sh -c "sleep 30 & echo \\$!; wait" & wait'
    const running = createExec({ PATH: process.env.PATH })(['sh', '-c', script], {
      cwd: scratch,
      timeoutMs: 20_000,
      signal: controller.signal,
    })
    await Bun.sleep(300)
    controller.abort()
    const r = await running
    const pid = Number(r.stdout.trim().split('\n')[0])
    expect(pid).toBeGreaterThan(1)
    await expectDead(pid)
  })

  test('networkEnv carries the proxy and CA settings of the remote calls, in both spellings', () => {
    const source = {
      HTTPS_PROXY: 'http://p:1',
      https_proxy: 'http://p:2',
      HTTP_PROXY: 'http://p:3',
      no_proxy: 'localhost',
      NO_PROXY: 'example.com',
      GIT_SSL_CAINFO: '/ca.pem',
      SSL_CERT_FILE: '/certs.pem',
      AGW_API_SECRET: 'nope',
    }
    expect(Object.keys(networkEnv(source)).sort()).toEqual(
      ['GIT_SSL_CAINFO', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'https_proxy', 'no_proxy'].sort(),
    )
    for (const name of Object.keys(source).filter((n) => n !== 'AGW_API_SECRET')) {
      expect(helperEnv(source)).not.toHaveProperty(name)
    }
  })
})

describe('tail', () => {
  test('the last non-empty lines, trimmed and joined', () => {
    expect(tail('a\n\n  b  \nc\nd\n')).toBe('b | c | d')
    expect(tail('a\nb', 1)).toBe('b')
    expect(tail('')).toBe('')
  })
})
