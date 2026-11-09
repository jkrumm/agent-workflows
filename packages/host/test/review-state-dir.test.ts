import { expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { boot } from '../src/boot.ts'
import { loadConfig } from '../src/config.ts'
import { freshSchema, PG_URL, SECRET } from './support.ts'
import { lines, makeRepo, write } from './support/review-repo.ts'

// `BootOptions.stateDir` reaches the review ledger: a booted host keeps review jobs (and pr/branch clones) under it,
// never under the real `~/.local/share`.

test('a booted host writes review jobs under BootOptions.stateDir', async () => {
  const fresh = freshSchema('reviewstate')
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'review-state-home-')))
  const stateDir = join(home, 'state')
  const repo = makeRepo({ 'src/a.ts': lines(2) })
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: home,
    XDG_STATE_HOME: home,
    AGW_ARGO_PUSH: '0',
    AGW_FACTORY_BIN: join(home, 'no-factory'),
    AGW_CLAUDE_ACCOUNT_BIN: join(home, 'no-claude-account'),
    AGW_API_SECRET: SECRET,
    AGW_MACHINE: 'test-machine',
    AGW_PG_URL: PG_URL,
    AGW_PG_SCHEMA: fresh.schema,
    AGW_PORT: '0',
    IU_API_KEY: 'test-key',
  }
  const running = await boot(loadConfig(env), { env, stateDir })
  try {
    write(repo, 'src/a.ts', lines(3))
    const response = await fetch(`http://127.0.0.1:${running.port}/review/prepare`, {
      method: 'POST',
      headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: repo, context: 'one more line' }),
    })
    expect(response.status).toBe(200)
    const { jobDir } = (await response.json()) as { jobDir: string }
    expect(jobDir.startsWith(join(stateDir, 'review-jobs'))).toBe(true)
  } finally {
    await running.shutdown()
    await fresh.drop()
    rmSync(home, { recursive: true, force: true })
    rmSync(repo, { recursive: true, force: true })
  }
}, 60_000)
