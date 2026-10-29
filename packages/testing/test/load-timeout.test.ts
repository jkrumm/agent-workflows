import { expect, setDefaultTimeout, test } from 'bun:test'
import { applyLoadScaledTimeout, CAP_MS, FLOOR_MS, type LoadSource, loadScaledTimeoutMs } from '../src/load-timeout.ts'

const CORES = 8

function fake(load: number): LoadSource & { applied: number[]; setLoad: (n: number) => void } {
  let current = load
  const applied: number[] = []
  return {
    applied,
    setLoad: (n) => {
      current = n
    },
    load: () => current,
    cores: () => CORES,
    apply: (ms) => applied.push(ms),
  }
}

test('scales 5000 ms by load per core, with floor and cap', () => {
  expect(loadScaledTimeoutMs(fake(0))).toBe(FLOOR_MS)
  expect(loadScaledTimeoutMs(fake(CORES))).toBe(5000)
  expect(loadScaledTimeoutMs(fake(4 * CORES))).toBe(20000)
  expect(loadScaledTimeoutMs(fake(1_000_000))).toBe(CAP_MS)
})

test('each application samples the load at that moment', () => {
  const source = fake(0)
  applyLoadScaledTimeout(source)
  source.setLoad(4 * CORES)
  applyLoadScaledTimeout(source)
  source.setLoad(1_000_000)
  applyLoadScaledTimeout(source)
  source.setLoad(0)
  applyLoadScaledTimeout(source)
  expect(source.applied).toEqual([5000, 20000, 30000, 5000])
})

// Registered under a 5 ms default; the test only passes if its explicit timeout wins. Bun binds the timeout at registration,
// so the default is restored right after.
setDefaultTimeout(5)
test('a test with its own timeout keeps it', async () => {
  await Bun.sleep(40)
}, 1000)
applyLoadScaledTimeout()
