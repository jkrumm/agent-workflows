import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compileLocation, LocationLeakError, locationHash, WarmCache } from '../src/index.ts'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), 'och-loc-'))
  dirs.push(d)
  return d
}

describe('compileLocation', () => {
  test('writes AGENTS.md, skills and config; idempotent by content hash', () => {
    const stateDir = scratch()
    const def = { name: 'reviewer', agentsMd: '# rules\n', skills: { 'diff/SKILL.md': 'skill' }, config: { a: 1 } }
    const first = compileLocation(def, { stateDir })
    expect(first).toEqual({
      name: 'reviewer',
      directory: join(stateDir, 'locations', 'reviewer'),
      hash: locationHash(def),
      changed: true,
    })
    expect(readFileSync(join(first.directory, 'AGENTS.md'), 'utf8')).toBe('# rules\n')
    expect(readFileSync(join(first.directory, '.opencode/skills/diff/SKILL.md'), 'utf8')).toBe('skill')
    expect(JSON.parse(readFileSync(join(first.directory, 'opencode.json'), 'utf8'))).toEqual({ a: 1 })
    expect(compileLocation(def, { stateDir }).changed).toBe(false)

    const edited = compileLocation({ ...def, agentsMd: '# rules v2\n', skills: {} }, { stateDir })
    expect(edited.changed).toBe(true)
    expect(edited.hash).not.toBe(first.hash)
    expect(existsSync(join(first.directory, '.opencode/skills/diff/SKILL.md'))).toBe(false)
  })

  test('the hash ignores key order and changes with any content', () => {
    const base = { name: 'a', agentsMd: 'x', skills: { 'p/SKILL.md': '1', 'q/SKILL.md': '2' } }
    expect(locationHash(base)).toBe(locationHash({ ...base, skills: { 'q/SKILL.md': '2', 'p/SKILL.md': '1' } }))
    expect(locationHash(base)).not.toBe(locationHash({ ...base, agentsMd: 'y' }))
    expect(locationHash(base)).not.toBe(locationHash({ ...base, config: {} }))
  })

  test.each(['AGENTS.md', 'CLAUDE.md', '.git'])('an ancestor %s is refused', (leak) => {
    const root = scratch()
    const stateDir = join(root, 'nested', 'state')
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(root, leak), '')
    expect(() => compileLocation({ name: 'a', agentsMd: '' }, { stateDir })).toThrow(LocationLeakError)
  })

  test('names and skill paths cannot leave the locations directory', () => {
    const stateDir = scratch()
    expect(() => compileLocation({ name: '../x', agentsMd: '' }, { stateDir })).toThrow('not a valid location name')
    expect(() => compileLocation({ name: 'a', agentsMd: '', skills: { '../../x': '' } }, { stateDir })).toThrow(
      'leaves',
    )
  })
})

describe('WarmCache', () => {
  function cache(options: { maxWarm?: number; evictAfterMs?: number } = {}) {
    const log: string[] = []
    let clock = 0
    const c = new WarmCache(
      { warm: async (d) => void log.push(`warm ${d}`), evict: async (d) => void log.push(`evict ${d}`) },
      { evictAfterMs: 1_000, ...options, now: () => clock },
    )
    return { c, log, advance: (ms: number) => (clock += ms) }
  }

  test('warms once, evicts after the idle time, never while in use', async () => {
    const { c, log, advance } = cache()
    const release = await c.use('/a')
    ;(await c.use('/a'))()
    advance(5_000)
    await c.tick()
    expect(log).toEqual(['warm /a'])
    release()
    advance(999)
    await c.tick()
    expect(log).toEqual(['warm /a'])
    advance(1)
    await c.tick()
    expect(log).toEqual(['warm /a', 'evict /a'])
  })

  test('bounded: the least recently used idle location goes first', async () => {
    const { c, log, advance } = cache({ maxWarm: 2, evictAfterMs: 60_000 })
    ;(await c.use('/a'))()
    advance(1)
    const holdB = await c.use('/b')
    advance(1)
    ;(await c.use('/c'))()
    expect(log).toEqual(['warm /a', 'warm /b', 'warm /c', 'evict /a'])
    holdB()
    expect(c.warm().sort()).toEqual(['/b', '/c'])
  })

  test('a changed location is evicted before its next use, or once its last user is done', async () => {
    const { c, log } = cache({ evictAfterMs: 60_000 })
    ;(await c.use('/a'))()
    ;(await c.use('/a', { changed: true }))()
    expect(log).toEqual(['warm /a', 'evict /a', 'warm /a'])
    const hold = await c.use('/a')
    ;(await c.use('/a', { changed: true }))()
    await c.tick()
    expect(log).toHaveLength(3)
    hold()
    await c.tick()
    expect(log.at(-1)).toBe('evict /a')
  })

  test('reset forgets idle locations after a server restart', async () => {
    const { c, log } = cache()
    ;(await c.use('/a'))()
    c.reset()
    ;(await c.use('/a'))()
    expect(log).toEqual(['warm /a', 'warm /a'])
  })
})
