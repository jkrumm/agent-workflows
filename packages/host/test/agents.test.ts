import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadAgentDefinitions } from '../src/agents.ts'

function agentsDir(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'agw-agents-'))
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
  return dir
}

describe('loadAgentDefinitions', () => {
  test('a missing directory means no agents', () => {
    expect(loadAgentDefinitions(join(tmpdir(), 'agw-no-such-dir'))).toEqual([])
  })

  test('reads AGENTS.md, skills and agent.json', () => {
    const dir = agentsDir({
      'review-senior/AGENTS.md': '# senior',
      'review-senior/skills/review/SKILL.md': 'skill',
      'review-senior/agent.json': JSON.stringify({
        route: 'review.angle',
        permissions: { rules: [{ action: 'edit', resource: '*', effect: 'deny' }] },
      }),
      'check/AGENTS.md': '# check',
      'notes/README.md': 'not an agent',
    })
    expect(loadAgentDefinitions(dir)).toEqual([
      { name: 'check', agentsMd: '# check' },
      {
        name: 'review-senior',
        agentsMd: '# senior',
        skills: { 'review/SKILL.md': 'skill' },
        route: 'review.angle',
        permissions: { rules: [{ action: 'edit', resource: '*', effect: 'deny' }] },
      },
    ])
  })

  test('an unknown route or key fails the load', () => {
    expect(() => loadAgentDefinitions(agentsDir({ 'a/AGENTS.md': 'x', 'a/agent.json': '{"route":"nope"}' }))).toThrow(
      /unknown route/,
    )
    expect(() => loadAgentDefinitions(agentsDir({ 'a/AGENTS.md': 'x', 'a/agent.json': '{"model":"x"}' }))).toThrow()
  })
})
