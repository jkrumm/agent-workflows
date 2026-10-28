import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { sessionPermissions } from '@agent-workflows/opencode-host'
import { loadAgentDefinitions } from '../src/agents.ts'
import { ALL_ANGLES } from '../src/workflows/review/schema.ts'

const agents = loadAgentDefinitions(join(import.meta.dir, '../../../agents'))
const named = (name: string) => agents.find((a) => a.name === name)

describe('agents/review-*', () => {
  test('every angle, the synthesis and the two single-call prompt carriers are defined', () => {
    const names = agents.filter((a) => a.name.startsWith('review-')).map((a) => a.name)
    expect(names.sort()).toEqual(
      [...ALL_ANGLES.map((a) => `review-${a}`), 'review-synthesis', 'review-router', 'review-adversary'].sort(),
    )
  })

  test('angles and the synthesis read the repo and never change it: edit denied, shell denied', () => {
    for (const name of [...ALL_ANGLES.map((a) => `review-${a}`), 'review-synthesis']) {
      const def = named(name)
      expect(def?.route).toBe(name === 'review-synthesis' ? 'review.synthesis' : 'review.angle')
      const rules = sessionPermissions(def as NonNullable<typeof def>, ['/repo'])
      expect(rules).toEqual([
        { action: 'shell', resource: '*', effect: 'deny' },
        { action: 'edit', resource: '*', effect: 'deny' },
        { action: 'external_directory', resource: '/repo/*', effect: 'allow' },
      ])
    }
  })

  test('the prompts were adapted to a session with no shell and the diff in the task message', () => {
    for (const name of ALL_ANGLES) {
      const text = named(`review-${name}`)?.agentsMd ?? ''
      expect(text).not.toContain('[GIT_DIFF_COMMAND]')
      expect(text).toContain('The diff under review is in the task message')
      expect(text).toContain('{ "findings": [] }')
    }
    const synthesis = named('review-synthesis')?.agentsMd ?? ''
    for (const placeholder of ['[ANGLE_RESULTS]', '[FALLOW_RESULTS]', '[REACT_DOCTOR_RESULTS]', '[OCR_RESULTS]']) {
      expect(synthesis).not.toContain(placeholder)
    }
    expect(synthesis).not.toContain('git show')
    expect(named('review-router')?.agentsMd).toContain('[GIT_DIFF_COMMAND]')
    expect(named('review-adversary')?.agentsMd).toContain('[DIFF]')
    expect(named('review-adversary')?.agentsMd).toContain('[CONTEXT_BLOCK]')
  })
})
