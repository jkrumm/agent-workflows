import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

const LAUNCH = join(import.meta.dir, '../../../scripts/launch.sh')
// The real interpreter, from PATH: /bin/zsh on the mini, /usr/bin/zsh on CI (installed by ci.yml). Never skipped.
const ZSH = Bun.which('zsh')

describe('launch.sh process selection', () => {
  test('an unknown process refuses with 78 before anything is read', () => {
    if (!ZSH) throw new Error('zsh is not on PATH: scripts/launch.sh needs it (CI installs it in ci.yml)')
    const run = Bun.spawnSync([ZSH, LAUNCH, 'nope'], { env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent' } })
    expect(run.exitCode).toBe(78)
    expect(run.stderr.toString()).toContain("unknown process 'nope' (host or audio)")
  })
})
