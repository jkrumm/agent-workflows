import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  basePolicy,
  basePolicyDigest,
  compileLocation,
  LocationLeakError,
  locationHash,
  pruneLocations,
  READ_ONLY_ACTIONS,
  sweepStaleTemps,
  touchLocation,
  WarmCache,
} from '../src/locations.ts'

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
  test('one directory per content hash, written once; a change is a new directory, the old one untouched', () => {
    const stateDir = scratch()
    const def = { name: 'reviewer', agentsMd: '# rules\n', skills: { 'diff/SKILL.md': 'skill' }, config: { a: 1 } }
    const first = compileLocation(def, { stateDir })
    expect(first.directory).toBe(join(stateDir, 'locations', 'reviewer', locationHash(def).slice(0, 16)))
    expect(first.changed).toBe(true)
    expect(readFileSync(join(first.directory, 'AGENTS.md'), 'utf8')).toBe('# rules\n')
    expect(readFileSync(join(first.directory, '.opencode/skills/diff/SKILL.md'), 'utf8')).toBe('skill')
    expect(JSON.parse(readFileSync(join(first.directory, 'opencode.json'), 'utf8'))).toEqual({ a: 1 })
    expect(compileLocation(def, { stateDir })).toEqual({ ...first, changed: false })

    const edited = compileLocation({ ...def, agentsMd: '# rules v2\n', skills: {} }, { stateDir })
    expect(edited.changed).toBe(true)
    expect(edited.directory).not.toBe(first.directory)
    expect(readFileSync(join(first.directory, '.opencode/skills/diff/SKILL.md'), 'utf8')).toBe('skill')
  })

  test('the hash ignores key order and changes with any content, permissions included', () => {
    const base = { name: 'a', agentsMd: 'x', skills: { 'p/SKILL.md': '1', 'q/SKILL.md': '2' } }
    expect(locationHash(base)).toBe(locationHash({ ...base, skills: { 'q/SKILL.md': '2', 'p/SKILL.md': '1' } }))
    expect(locationHash(base)).not.toBe(locationHash({ ...base, agentsMd: 'y' }))
    expect(locationHash(base)).not.toBe(locationHash({ ...base, config: {} }))
    expect(locationHash(base)).not.toBe(locationHash({ ...base, permissions: { shell: true } }))
  })

  test('the host’s base policy is part of every agent’s hash: a changed default moves it', () => {
    const base = { name: 'a', agentsMd: 'x' }
    expect(basePolicy()[0]).toEqual({ action: '*', resource: '*', effect: 'deny' })
    expect(
      basePolicy()
        .slice(1)
        .map((r) => r.action),
    ).toEqual([...READ_ONLY_ACTIONS])
    const before = locationHash(base)
    const digest = basePolicyDigest()
    const actions = READ_ONLY_ACTIONS as unknown as string[]
    actions.push('webfetch')
    try {
      expect(locationHash(base)).not.toBe(before)
      expect(basePolicyDigest()).not.toBe(digest) // the run fingerprint's policy input moves with it
    } finally {
      actions.pop()
    }
    expect(locationHash(base)).toBe(before)
    expect(basePolicyDigest()).toBe(digest)
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

  test('prune removes only unkept hash directories past the retention', () => {
    const stateDir = scratch()
    const a = compileLocation({ name: 'a', agentsMd: '1' }, { stateDir }).directory
    const b = compileLocation({ name: 'a', agentsMd: '2' }, { stateDir }).directory
    const c = compileLocation({ name: 'a', agentsMd: '3' }, { stateDir }).directory
    const now = Date.now()
    touchLocation(a, new Date(now - 10_000))
    touchLocation(b, new Date(now - 10_000))
    touchLocation(c, new Date(now - 1_000))
    expect(pruneLocations({ stateDir, keep: new Set([a]), retentionMs: 5_000, now })).toEqual([b])
    expect([a, b, c].map(existsSync)).toEqual([true, false, true])
  })
})

test('stray files (.DS_Store) are neither walked into nor removed', () => {
  const stateDir = scratch()
  compileLocation({ name: 'a', agentsMd: '1' }, { stateDir })
  writeFileSync(join(stateDir, 'locations/.DS_Store'), '')
  writeFileSync(join(stateDir, 'locations/a/.DS_Store'), '')
  writeFileSync(join(stateDir, 'locations/a/.tmp-file'), '')
  const old = new Date(Date.now() - 3_600_000)
  utimesSync(join(stateDir, 'locations/a/.tmp-file'), old, old)
  expect(pruneLocations({ stateDir, keep: new Set(), retentionMs: 0, now: Date.now() + 1_000 })).toHaveLength(1)
  expect(sweepStaleTemps({ stateDir })).toEqual([])
  expect(existsSync(join(stateDir, 'locations/a/.DS_Store'))).toBe(true)
  expect(existsSync(join(stateDir, 'locations/a/.tmp-file'))).toBe(true)
})

test('stale temp builds and server.json temps are swept, fresh ones kept', () => {
  const stateDir = scratch()
  compileLocation({ name: 'a', agentsMd: '1' }, { stateDir })
  const oldBuild = join(stateDir, 'locations/a/.tmp-old')
  const newBuild = join(stateDir, 'locations/a/.tmp-new')
  mkdirSync(oldBuild)
  mkdirSync(newBuild)
  mkdirSync(join(stateDir, 'opencode'))
  const oldState = join(stateDir, 'opencode/server.json.tmp-123')
  writeFileSync(oldState, '{}')
  const now = Date.now()
  const old = new Date(now - 11 * 60_000)
  utimesSync(oldBuild, old, old)
  utimesSync(oldState, old, old)
  expect(sweepStaleTemps({ stateDir, now }).sort()).toEqual([oldBuild, oldState].sort())
  expect([oldBuild, newBuild, oldState].map(existsSync)).toEqual([false, true, false])
})

/** A port whose warm and evict calls block until released, so tests can interleave them. */
function gatedPort() {
  const log: string[] = []
  const gates: { op: string; release: (err?: Error) => void }[] = []
  const call = (op: string) =>
    new Promise<void>((resolve, reject) => {
      log.push(op)
      gates.push({ op, release: (err) => (err ? reject(err) : resolve()) })
    })
  return {
    log,
    port: { warm: (d: string) => call(`warm ${d}`), evict: (d: string) => call(`evict ${d}`) },
    /** Releases the oldest pending call. */
    async next(err?: Error) {
      for (let i = 0; i < 50 && gates.length === 0; i++) await Bun.sleep(1)
      const gate = gates.shift()
      if (!gate) throw new Error('no pending call')
      gate.release(err)
      await Bun.sleep(1)
      return gate.op
    },
    pending: () => gates.map((g) => g.op),
  }
}

function instantPort(options: { failEvict?: () => boolean } = {}) {
  const log: string[] = []
  return {
    log,
    port: {
      warm: async (d: string) => void log.push(`warm ${d}`),
      evict: async (d: string) => {
        log.push(`evict ${d}`)
        if (options.failEvict?.()) throw new Error('boom')
      },
    },
  }
}

describe('WarmCache', () => {
  test('(a) concurrent first uses share one warm and one refcounted entry', async () => {
    const p = gatedPort()
    const c = new WarmCache(p.port, { evictAfterMs: 0 })
    const uses = [c.use('/a'), c.use('/a'), c.use('/a')]
    await Bun.sleep(5)
    expect(p.pending()).toEqual(['warm /a'])
    await p.next()
    const releases = await Promise.all(uses)
    expect(p.log).toEqual(['warm /a'])
    releases[0]?.()
    releases[1]?.()
    await c.tick()
    expect(p.log).toEqual(['warm /a']) // one user left
    releases[2]?.()
    const ticking = c.tick()
    await p.next()
    await ticking
    expect(p.log).toEqual(['warm /a', 'evict /a'])
  })

  test('(a) a failed warm fails every waiter and leaves no entry behind', async () => {
    const p = gatedPort()
    const c = new WarmCache(p.port)
    const uses = Promise.allSettled([c.use('/a'), c.use('/a')])
    await Bun.sleep(5)
    await p.next(new Error('down'))
    expect((await uses).map((r) => (r.status === 'rejected' ? (r.reason as Error).message : 'ok'))).toEqual([
      'down',
      'down',
    ])
    expect(c.known().size).toBe(0)
  })

  test('(b) an eviction failure in shrink never leaks a use count and is retried next tick', async () => {
    let fail = true
    const p = instantPort({ failEvict: () => fail })
    const warnings: string[] = []
    const c = new WarmCache(p.port, {
      maxWarm: 1,
      evictAfterMs: 60_000,
      logger: { warn: (m) => warnings.push(m), error: () => {} },
    })
    ;(await c.use('/a'))()
    const releaseB = await c.use('/b') // shrink tries to evict /a and fails: logged, /b's use still counts
    expect(warnings).toEqual(['opencode location eviction failed; retried next tick'])
    expect(c.warmLocations().sort()).toEqual(['/a', '/b'])
    fail = false
    await c.tick()
    expect(c.warmLocations()).toEqual(['/b']) // /b is in use, /a goes
    releaseB()
  })

  test('(b) shrink re-checks each entry: a use() during an earlier DELETE keeps its location', async () => {
    const p = gatedPort()
    const c = new WarmCache(p.port, { maxWarm: 1, evictAfterMs: 60_000 })
    const hold = async (d: string) => {
      const u = c.use(d)
      await p.next()
      return u
    }
    const releases = [await hold('/a'), await hold('/b'), await hold('/c')] // three warm, all in use: nothing to shrink
    for (const r of releases) r()
    const d = c.use('/d') // warm 4 > 1: shrink snapshots idle [/a, /b, /c] and evicts /a first
    await p.next() // warm /d
    await Bun.sleep(5)
    expect(p.pending()).toEqual(['evict /a'])
    const useB = c.use('/b') // /b is in use while /a's DELETE is in flight
    for (let i = 0; i < 10 && p.pending().length > 0; i++) await p.next()
    ;(await useB)()
    ;(await d)()
    expect(p.log.filter((op) => op === 'evict /b')).toEqual([])
    expect(p.log).toContain('evict /c')
  })

  test('(c) a use during an eviction waits for it and warms again', async () => {
    const p = gatedPort()
    const c = new WarmCache(p.port, { evictAfterMs: 0 })
    const first = c.use('/a')
    await p.next()
    ;(await first)()
    const ticking = c.tick()
    await Bun.sleep(5)
    expect(p.pending()).toEqual(['evict /a'])
    const again = c.use('/a') // arrives while the DELETE is in flight
    await Bun.sleep(5)
    expect(p.pending()).toEqual(['evict /a']) // it waits; no warm yet
    await p.next()
    await ticking
    await p.next() // the re-warm
    const release = await again
    expect(p.log).toEqual(['warm /a', 'evict /a', 'warm /a'])
    expect(c.warmLocations()).toEqual(['/a'])
    release()
  })

  test('(d) reset keeps the counts and makes the next use warm again', async () => {
    const p = instantPort()
    const c = new WarmCache(p.port, { evictAfterMs: 0 })
    const held = await c.use('/a')
    c.reset() // the server restarted
    expect(c.warmLocations()).toEqual([])
    await c.tick()
    expect(c.known().has('/a')).toBe(true) // still in use: kept
    ;(await c.use('/a'))()
    expect(p.log).toEqual(['warm /a', 'warm /a'])
    held()
  })

  test('(e) changed content with no entry disposes the location before warming it', async () => {
    const p = instantPort()
    const c = new WarmCache(p.port)
    ;(await c.use('/a', { changed: true }))()
    expect(p.log).toEqual(['evict /a', 'warm /a'])
  })

  test('changed content on a warm entry is evicted before the next use, or once its last user is done', async () => {
    const p = instantPort()
    const c = new WarmCache(p.port, { evictAfterMs: 60_000 })
    ;(await c.use('/a'))()
    ;(await c.use('/a', { changed: true }))()
    expect(p.log).toEqual(['warm /a', 'evict /a', 'warm /a'])
    const hold = await c.use('/a')
    ;(await c.use('/a', { changed: true }))()
    await c.tick()
    expect(p.log).toHaveLength(3)
    hold()
    await c.tick()
    expect(p.log.at(-1)).toBe('evict /a')
  })

  test('bounded: the least recently used idle location goes first', async () => {
    let clock = 0
    const p = instantPort()
    const c = new WarmCache(p.port, { maxWarm: 2, evictAfterMs: 60_000, now: () => clock })
    ;(await c.use('/a'))()
    clock++
    const holdB = await c.use('/b')
    clock++
    ;(await c.use('/c'))()
    expect(p.log).toEqual(['warm /a', 'warm /b', 'warm /c', 'evict /a'])
    holdB()
    expect(c.warmLocations().sort()).toEqual(['/b', '/c'])
  })
})
