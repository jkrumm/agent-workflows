import { readFileSync } from 'node:fs'
import { expect } from 'bun:test'

export type Life = 'alive' | 'zombie' | 'gone'

/**
 * Whether `pid` still runs. `kill(pid, 0)` succeeds on a zombie (dead, not yet reaped by whoever adopted it), so the
 * process state decides: `/proc/<pid>/stat` on Linux, `ps -o stat=` elsewhere. `zombie` and `gone` are both dead.
 */
export function lifeOf(pid: number): Life {
  if (process.platform === 'linux') {
    let stat: string
    try {
      stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    } catch {
      return 'gone'
    }
    // `pid (comm) S …`: comm may hold spaces and parentheses, so the state follows the last `)`.
    return stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z') ? 'zombie' : 'alive'
  }
  try {
    process.kill(pid, 0)
  } catch {
    return 'gone'
  }
  const state = Bun.spawnSync(['ps', '-o', 'stat=', '-p', String(pid)])
    .stdout.toString()
    .trim()
  if (state === '') return 'gone'
  return state.startsWith('Z') ? 'zombie' : 'alive'
}

export const isAlive = (pid: number) => lifeOf(pid) === 'alive'

/** Polls every 50 ms, for at most `withinMs`, until `pid` is dead (gone or a zombie); a kill is not a reap. */
export async function expectDead(pid: number, withinMs = 3_000) {
  const until = Date.now() + withinMs
  let life = lifeOf(pid)
  while (life === 'alive' && Date.now() < until) {
    await Bun.sleep(50)
    life = lifeOf(pid)
  }
  expect(life).not.toBe('alive')
}
