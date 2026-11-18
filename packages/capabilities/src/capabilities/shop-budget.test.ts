import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CapabilityError } from '../errors.ts'
import { createReadBudget, DEFAULT_DAILY_CAPS, parseDailyCaps, shopDataDir } from './shop-budget.ts'

const scratch = () => mkdtempSync(join(tmpdir(), 'shop-budget-'))
const at = (iso: string) => new Date(iso).getTime()

describe('the daily read budget', () => {
  test('counts every read per host and day, in the data directory', async () => {
    const dir = scratch()
    let now = at('2026-11-18T08:00:00')
    const budget = createReadBudget({ dir, now: () => now })
    expect(await budget.today('www.idealo.de')).toMatchObject({ day: '2026-11-18', count: 0, cap: 80 })
    expect(await budget.take('www.idealo.de')).toMatchObject({ count: 1, cap: 80 })
    expect(await budget.take('www.idealo.de')).toMatchObject({ count: 2 })
    // Another host has its own count and, by default, no cap.
    expect(await budget.take('geizhals.de')).toMatchObject({ count: 1, cap: null })
    expect(await budget.today('www.idealo.de')).toMatchObject({ count: 2 })
    expect(JSON.parse(readFileSync(join(dir, 'reads.json'), 'utf8'))).toEqual({
      '2026-11-18': { 'www.idealo.de': 2, 'geizhals.de': 1 },
    })
    // The next day starts from zero; the old day is kept for a while.
    now = at('2026-11-19T00:05:00')
    expect(await budget.take('www.idealo.de')).toMatchObject({ day: '2026-11-19', count: 1 })
    expect(Object.keys(JSON.parse(readFileSync(join(dir, 'reads.json'), 'utf8')))).toEqual(['2026-11-18', '2026-11-19'])
  })

  test('refuses the read that would pass the cap and counts nothing for it', async () => {
    const dir = scratch()
    const budget = createReadBudget({ dir, now: () => at('2026-11-18T08:00:00'), caps: () => ({ 'www.idealo.de': 2 }) })
    await budget.take('www.idealo.de')
    await budget.take('www.idealo.de')
    const error = await budget.take('www.idealo.de').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CapabilityError)
    expect((error as Error).message).toContain('daily read cap reached for www.idealo.de: 2 of 2 on 2026-11-18')
    expect(await budget.today('www.idealo.de')).toMatchObject({ count: 2, cap: 2 })
  })

  test('keeps the last fortnight and no more', async () => {
    const dir = scratch()
    const days = Array.from({ length: 20 }, (_, i) => `2026-10-${String(i + 1).padStart(2, '0')}`)
    writeFileSync(
      join(dir, 'reads.json'),
      JSON.stringify(Object.fromEntries(days.map((d) => [d, { 'www.idealo.de': 1 }]))),
    )
    await createReadBudget({ dir, now: () => at('2026-11-18T08:00:00') }).take('www.idealo.de')
    const kept = Object.keys(JSON.parse(readFileSync(join(dir, 'reads.json'), 'utf8')))
    expect(kept).toHaveLength(14)
    expect(kept.at(-1)).toBe('2026-11-18')
  })

  test('a damaged counter stops the read instead of resetting the count', async () => {
    const dir = scratch()
    writeFileSync(join(dir, 'reads.json'), '{not json')
    const budget = createReadBudget({ dir, now: () => at('2026-11-18T08:00:00') })
    expect(await budget.take('www.idealo.de').catch((e: Error) => e.message)).toContain('is not valid JSON')
    expect(readFileSync(join(dir, 'reads.json'), 'utf8')).toBe('{not json')
  })
})

describe('configuration', () => {
  test('idealo has a cap of 80 a day; the environment replaces or lifts a cap', () => {
    expect(DEFAULT_DAILY_CAPS).toEqual({ 'www.idealo.de': 80 })
    expect(parseDailyCaps(undefined)).toEqual({ 'www.idealo.de': 80 })
    expect(parseDailyCaps('www.idealo.de=60, geizhals.de=40')).toEqual({ 'www.idealo.de': 60, 'geizhals.de': 40 })
    expect(parseDailyCaps('www.idealo.de=0')).toEqual({})
  })

  test('a malformed entry is an error, so a typo does not lift the cap', () => {
    expect(() => parseDailyCaps('www.idealo.de:60')).toThrow('not host=number')
    expect(() => parseDailyCaps('www.idealo.de=many')).toThrow('not host=number')
  })

  test('the data directory is AGW_SHOP_DIR, else under the home directory', () => {
    expect(shopDataDir({ AGW_SHOP_DIR: '/var/shop' })).toBe('/var/shop')
    expect(shopDataDir({})).toMatch(/\.agent-workflows\/data\/shop$/)
  })
})
