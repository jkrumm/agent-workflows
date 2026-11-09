import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { describeZsh, ZSH } from '@agent-workflows/testing/zsh'

const LAUNCH = join(import.meta.dir, '../../../scripts/launch.sh')

describeZsh('launch.sh process selection', () => {
  test('an unknown process refuses with 78 before anything is read', () => {
    const run = Bun.spawnSync([ZSH, LAUNCH, 'nope'], { env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent' } })
    expect(run.exitCode).toBe(78)
    expect(run.stderr.toString()).toContain("unknown process 'nope' (host or audio)")
  })
})
