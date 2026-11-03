import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { defineWorkflow } from '@agent-workflows/runtime'
import { DEFAULT_PURPOSE, EVAL_WORKFLOW_IDS, type HostWorkflow, purposeOf } from '../src/operations.ts'
import { EVAL_MINE_ID } from '../src/workflows/eval-mine/index.ts'
import { EVAL_RECALL_ID } from '../src/workflows/eval-recall/index.ts'
import { EVAL_COMPARE_ID } from '../src/workflows/eval/compare.ts'
import { EVAL_RUN_ID } from '../src/workflows/eval/run.ts'
import { startTestHost, type TestHost } from './support.ts'

const leaf = defineWorkflow({
  id: 'purpose.leaf',
  version: 'v1',
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
  run: async (ctx) => ({ ok: await ctx.step('leaf', () => true) }),
})

/** A workflow with an eval id and one fan-out child, so a child's purpose can be read. */
const parent = (id: string) =>
  defineWorkflow({
    id,
    version: 'v1',
    input: z.object({}),
    output: z.object({ ok: z.boolean() }),
    run: async (ctx) => {
      await ctx.workflow('fan', leaf, [{}])
      return { ok: true }
    },
  })

const evalParent = parent('eval.mine')
const plainParent = parent('purpose.plain')

let t: TestHost
beforeAll(async () => {
  const extra: HostWorkflow[] = [
    { workflow: leaf, internal: true },
    { workflow: evalParent },
    { workflow: plainParent },
  ]
  t = await startTestHost({ prefix: 'purpose', extra })
})
afterAll(async () => {
  await t.close()
})

const rows = async (workflow: string) =>
  (await t.pool.query(`select id, purpose, parent_id from "${t.schema}".runs where workflow = $1`, [workflow])).rows

describe('purposeOf', () => {
  test('the list is exactly the ids `agw eval *` starts', () => {
    expect([...EVAL_WORKFLOW_IDS].sort()).toEqual([EVAL_RUN_ID, EVAL_COMPARE_ID, EVAL_MINE_ID, EVAL_RECALL_ID].sort())
  })

  test('no header: eval for an eval workflow, prod for any other', () => {
    for (const id of EVAL_WORKFLOW_IDS) expect(purposeOf(new Headers(), id)).toBe('eval')
    expect(purposeOf(new Headers({ 'x-agw-purpose': '  ' }), 'eval.run')).toBe('eval')
    expect(purposeOf(new Headers(), 'review')).toBe(DEFAULT_PURPOSE)
    expect(purposeOf(new Headers())).toBe(DEFAULT_PURPOSE)
  })

  test('an explicit header wins, for an eval workflow too', () => {
    expect(purposeOf(new Headers({ 'x-agw-purpose': 'prod' }), 'eval.run')).toBe('prod')
    expect(purposeOf(new Headers({ 'x-agw-purpose': 'drift' }), 'eval.mine')).toBe('drift')
    expect(() => purposeOf(new Headers({ 'x-agw-purpose': 'has space' }), 'eval.run')).toThrow()
  })
})

describe('a workflow start', () => {
  test('an eval workflow without a header runs as eval, and so does its child', async () => {
    const started = await t.json(await t.call('/workflows/eval/mine', { body: {}, headers: { prefer: 'wait=10' } }))
    expect(started.body.status).toBe('done')
    const [top] = (await rows('eval.mine')).filter((r) => r.id === started.body.runId)
    expect(top.purpose).toBe('eval')
    const children = (await rows('purpose.leaf')).filter((r) => r.parent_id === started.body.runId)
    expect(children.map((c) => c.purpose)).toEqual(['eval'])
  })

  test('an eval workflow with x-agw-purpose: prod runs as prod, and so does its child', async () => {
    const started = await t.json(
      await t.call('/workflows/eval/mine', { body: {}, headers: { prefer: 'wait=10', 'x-agw-purpose': 'prod' } }),
    )
    const [top] = (await rows('eval.mine')).filter((r) => r.id === started.body.runId)
    expect(top.purpose).toBe('prod')
    const children = (await rows('purpose.leaf')).filter((r) => r.parent_id === started.body.runId)
    expect(children.map((c) => c.purpose)).toEqual(['prod'])
  })

  test('a non-eval workflow without a header stays prod', async () => {
    const started = await t.json(await t.call('/workflows/purpose/plain', { body: {}, headers: { prefer: 'wait=10' } }))
    const [top] = (await rows('purpose.plain')).filter((r) => r.id === started.body.runId)
    expect(top.purpose).toBe('prod')
  })
})
