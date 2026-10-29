import { describe, expect, test } from 'bun:test'
import { snapBoundaries } from './input.ts'
describe('snapBoundaries (pure)', () => {
  test('snaps a target to the nearest in-window silence midpoint', () => {
    const result = snapBoundaries([100], [{ start: 95, end: 105 }], {
      windowSec: 20,
      totalSeconds: 200,
      maxChunkSeconds: Infinity,
    })
    expect(result).toEqual([100]) // midpoint of [95,105] is exactly 100
  })

  test('picks the closest of several candidate silences', () => {
    const result = snapBoundaries(
      [100],
      [
        { start: 60, end: 70 }, // midpoint 65, dist 35
        { start: 108, end: 112 }, // midpoint 110, dist 10
      ],
      { windowSec: 50, totalSeconds: 200, maxChunkSeconds: Infinity },
    )
    expect(result).toEqual([110])
  })

  test('leaves the target unchanged when no silence falls in window', () => {
    const result = snapBoundaries([100], [{ start: 0, end: 5 }], {
      windowSec: 20,
      totalSeconds: 200,
      maxChunkSeconds: Infinity,
    })
    expect(result).toEqual([100])
  })

  test('handles an empty silences array', () => {
    const result = snapBoundaries([50, 100, 150], [], { windowSec: 20, totalSeconds: 200, maxChunkSeconds: Infinity })
    expect(result).toEqual([50, 100, 150])
  })

  test('discards a snap that would be non-increasing, falling back to the hard target instead', () => {
    // A single silence range sits between both targets: the first target
    // (100) snaps to its midpoint (150); the second target (200) is also in
    // that silence's window and would want to snap to the same 150, but that
    // is <= the already-chosen first boundary, so it discards the snap and
    // keeps its own hard target (200) — boundaries stay strictly increasing.
    const result = snapBoundaries([100, 200], [{ start: 140, end: 160 }], {
      windowSec: 60,
      totalSeconds: 400,
      maxChunkSeconds: Infinity,
    })
    expect(result).toEqual([150, 200])
    expect(result[1] ?? 0).toBeGreaterThan(result[0] ?? 0)
  })

  test('never produces a boundary outside (0, totalSeconds)', () => {
    const result = snapBoundaries([50], [{ start: -10, end: 5 }], {
      windowSec: 60,
      totalSeconds: 100,
      maxChunkSeconds: Infinity,
    })
    // midpoint would be -2.5, invalid — falls back to the hard target.
    expect(result).toEqual([50])
  })

  // --- B1: reject a snap that would push either adjacent chunk over maxChunkSeconds ---

  test('discards a snap that would push the LEFT (preceding) chunk over maxChunkSeconds', () => {
    // Silence midpoint 670 is within the 100s window of target 600, and would
    // otherwise be a valid snap (it's still < totalSeconds, and increasing).
    // But the left chunk it would create (670 - prev(0) = 670) exceeds the
    // 600s cap, so the snap is discarded and the hard target (600) is kept.
    const result = snapBoundaries([600], [{ start: 660, end: 680 }], {
      windowSec: 100,
      totalSeconds: 700,
      maxChunkSeconds: 600,
    })
    expect(result).toEqual([600])
  })

  test('discards a snap that would push the RIGHT (final) chunk over maxChunkSeconds', () => {
    // Silence midpoint 540 is within window of target 600 and keeps the left
    // chunk (540 - 0 = 540) under the 600s cap — but this is the LAST
    // boundary, so the final chunk runs from here to totalSeconds (1300).
    // 1300 - 540 = 760 exceeds the cap, so the snap is discarded.
    const result = snapBoundaries([600], [{ start: 530, end: 550 }], {
      windowSec: 100,
      totalSeconds: 1300,
      maxChunkSeconds: 600,
    })
    expect(result).toEqual([600])
  })

  test('two adjacent boundaries drifting in opposite directions no longer overrun the middle chunk', () => {
    // Each snap looks valid in isolation (checked against the next HARD
    // TARGET, since the neighbor hasn't been decided yet): boundary 1 drifts
    // early to 510 (checked against target 1200), boundary 2 drifts late to
    // 1290 (checked against target 600's hard-target-spaced gap). But once
    // boundary 1 is actually fixed at 510, boundary 2's own left-chunk check
    // (1290 - 510 = 780) exceeds the 700s cap and is discarded, falling back
    // to its hard target (1200) — the middle chunk stays within the cap.
    const silences = [
      { start: 500, end: 520 }, // midpoint 510, near target 600 (-90)
      { start: 1280, end: 1300 }, // midpoint 1290, near target 1200 (+90)
    ]
    const result = snapBoundaries([600, 1200], silences, { windowSec: 90, totalSeconds: 1800, maxChunkSeconds: 700 })
    expect(result).toEqual([510, 1200])
    expect((result[1] ?? 0) - (result[0] ?? 0)).toBeLessThanOrEqual(700)
  })

  test('still snaps when neither adjacent chunk would overrun maxChunkSeconds', () => {
    const result = snapBoundaries([600], [{ start: 590, end: 610 }], {
      windowSec: 100,
      totalSeconds: 900,
      maxChunkSeconds: 600,
    })
    expect(result).toEqual([600]) // midpoint of [590,610] is exactly 600, well within both caps
  })
})
