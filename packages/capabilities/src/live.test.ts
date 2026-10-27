import { describe, expect, test } from 'bun:test'
import { createCapabilities } from './capabilities/index.ts'
import type { Usage } from './context.ts'
import { createRegistry } from './registry.ts'

// Real IU calls, a few cents in total. Run with:
//   AGW_LIVE=1 secrets-run run --env-file=.env.tpl -- bun test packages/capabilities
const live = process.env.AGW_LIVE === '1'
const skipped = (name: string) => (live ? name : `${name} (skipped: runs only with AGW_LIVE=1)`)

const registry = createRegistry(createCapabilities())
const spend: { capability: string; usage: Usage }[] = []

/** Reports each billed call from one capability call and prints the result. */
function tracked(capability: string) {
  return {
    addUsage: (usage: Usage) => {
      spend.push({ capability, usage })
      console.log(`live ${capability} usage ${JSON.stringify(usage)}`)
    },
  }
}

const show = (capability: string, out: unknown) => console.log(`live ${capability}: ${JSON.stringify(out)}`)

const TEXT =
  'The nightly backup job failed on Tuesday because the target disk filled up. ' +
  'The on-call engineer freed 40 GB by pruning old snapshots, re-ran the job, and it completed in 12 minutes. ' +
  'A follow-up ticket proposes alerting when free space drops below 15 percent.'

describe('live smoke', () => {
  test.skipIf(!live)(skipped('llm.summarize'), async () => {
    const out = await registry.call('llm.summarize', { text: TEXT, maxWords: 40 }, tracked('llm.summarize'))
    show('llm.summarize', out)
    expect(out.summary.length).toBeGreaterThan(20)
  })

  test.skipIf(!live)(skipped('llm.title'), async () => {
    const out = await registry.call('llm.title', { text: TEXT }, tracked('llm.title'))
    show('llm.title', out)
    expect(out.title.length).toBeGreaterThan(3)
    expect(out.title).not.toContain('\n')
  })

  test.skipIf(!live)(skipped('llm.classify'), async () => {
    const out = await registry.call(
      'llm.classify',
      {
        text: TEXT,
        labels: {
          incident: 'an outage or failure and how it was handled',
          feature: 'a request for new product behaviour',
          marketing: 'promotional copy',
        },
      },
      tracked('llm.classify'),
    )
    show('llm.classify', out)
    expect(out.label).toBe('incident')
    expect(out.reason.length).toBeGreaterThan(0)
  })

  test.skipIf(!live)(skipped('decide'), async () => {
    const out = await registry.call(
      'decide',
      {
        state: TEXT,
        questions: {
          severity: {
            type: 'choice',
            instructions: 'How severe was the incident for customers?',
            options: { none: 'no customer impact', minor: 'minor, internal only', major: 'customers were affected' },
          },
          followup: { type: 'boolean', instructions: 'Is a follow-up action proposed?' },
        },
      },
      tracked('decide'),
    )
    show('decide', out)
    expect(out.answers.followup).toMatchObject({ type: 'boolean', value: true })
  })

  test.skipIf(!live)(skipped('total spend'), () => {
    const known = spend.filter((s) => s.usage.cost !== null)
    const total = known.reduce((sum, s) => sum + (s.usage.cost ?? 0), 0)
    console.log(
      `live total: ${spend.length} calls, cost $${total.toFixed(6)} over ${known.length} priced calls, ` +
        `${spend.length - known.length} unpriced (${
          spend
            .filter((s) => s.usage.cost === null)
            .map((s) => s.capability)
            .join(', ') || 'none'
        })`,
    )
    expect(spend.length).toBeGreaterThanOrEqual(4)
  })
})
