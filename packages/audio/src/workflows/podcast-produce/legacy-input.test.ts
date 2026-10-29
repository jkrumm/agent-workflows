import { describe, expect, test } from 'bun:test'
import { produceInputFromLegacy } from './legacy-input.ts'
import { episodeInput } from './testing.ts'

const sample = episodeInput()
const legacy = {
  job: { id: 'fc782847-0000-4000-8000-000000000000', createdAt: '2026-10-25T20:43:53.357Z' },
  script: {
    ...sample.metadata,
    language: sample.script.language,
    segments: sample.script.segments,
    wordCount: sample.script.wordCount,
    hosts: sample.hosts,
  },
  request: { series: 'Brain Sonderausgabe', language: 'de' as const, minutes: 3, cover: true },
  state: {
    profile: {
      ...sample.profile,
      durationSeconds: 412,
      segmentation: { units: 3, minChars: 1, meanChars: 2, maxChars: 3, findings: [] },
    },
  },
}

describe('produceInputFromLegacy', () => {
  test("the room's hand-off from a legacy job: publish and brain note off by default, produced fields cleared", () => {
    const input = produceInputFromLegacy({ ...legacy, flags: { publish: false, brainNote: false, cover: true } })
    expect(input.episode).toEqual(legacy.job)
    expect(input.metadata).toEqual(sample.metadata)
    expect(input.script.segments).toEqual(sample.script.segments)
    expect(input.request).toEqual({
      series: 'Brain Sonderausgabe',
      language: 'de',
      minutes: 3,
      publish: false,
      cover: true,
      brainNote: false,
    })
    expect(input.profile.durationSeconds).toBeNull()
    expect(input.profile.segmentation).toBeUndefined()
  })

  test('--publish and --brain-note turn those on; a legacy request without a cover keeps it off', () => {
    const input = produceInputFromLegacy({
      ...legacy,
      request: { ...legacy.request, cover: false },
      flags: { publish: true, brainNote: true, cover: true },
    })
    expect(input.request).toMatchObject({ publish: true, brainNote: true, cover: false })
  })

  test('a job older than the profile is refused', () => {
    expect(() =>
      produceInputFromLegacy({
        ...legacy,
        state: { profile: null },
        flags: { publish: false, brainNote: false, cover: true },
      }),
    ).toThrow('no profile')
  })
})
