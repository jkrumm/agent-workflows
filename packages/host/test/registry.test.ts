import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCapabilities, createRegistry } from '@agent-workflows/capabilities'
import { fakeTransports } from '@agent-workflows/capabilities/testing'
import { DEFAULT_ROUTES, discoverRoutes } from '@agent-workflows/routes'
import { ToolGate } from '../src/tool-gate/index.ts'
import { EVAL_COMPARE_ID, EVAL_RUN_ID } from '../src/workflows/eval/index.ts'
import {
  buildWorkflows,
  createWorkflows,
  discoverWorkflowModules,
  hostModules,
  suitesOf,
} from '../src/workflows/index.ts'

// Fixture trees: `ok` (a module with a plain suite and its route group), and one broken tree per boot failure.
const FIXTURES = join(import.meta.dir, 'fixtures/registry')
const at = (...parts: string[]) => join(FIXTURES, ...parts)

const registry = createRegistry(createCapabilities({ transports: fakeTransports({}), env: {} }))
// Never opened: a gate touches nothing on disk until a workflow grants a step.
const toolGate = new ToolGate({ stateDir: '/nonexistent/agw-registry', call: async () => null })
const deps = { registry, toolGate }
/** The message a promise rejects with (support.ts has one, but it needs Postgres). */
async function rejection(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  )
  if (!(error instanceof Error)) throw new Error('expected a rejection')
  return error.message
}

const known =
  (...tables: Record<string, unknown>[]) =>
  (id: string) =>
    tables.some((t) => Object.hasOwn(t, id))

describe('workflow discovery', () => {
  test('the host tree: every workflow directory, sorted, the retrospective in the last phase', async () => {
    const HOST_MODULES = await hostModules()
    expect(HOST_MODULES.map((m) => m.id)).toEqual([
      'brain',
      'check',
      'diagram',
      'eval',
      'image-icon',
      'image',
      'learnings',
      'narrative',
      'otel',
      'overview',
      'prose-polish',
      'prose',
      'research',
      'retrospective',
      'review',
      'smoke',
    ])
    expect(HOST_MODULES.filter((m) => m.phase === 'last').map((m) => m.id)).toEqual(['retrospective'])
    expect([...suitesOf(HOST_MODULES).keys()]).toEqual([
      'brain',
      'check',
      'diagram',
      'image',
      'otel',
      'prose',
      'research',
      'review',
    ])
  })

  test('a new module directory is discovered, its suite joins the eval enum, its route group the table', async () => {
    const [alpha] = await discoverWorkflowModules(at('ok/workflows'))
    expect(alpha).toMatchObject({ id: 'alpha', suite: 'plain', file: at('ok/workflows/alpha/module.ts') })
    const routes = await discoverRoutes(at('ok/routes'))
    expect(Object.keys(routes)).toEqual(['alpha.agent'])

    const modules = [...(await hostModules()), alpha].filter((m) => m !== undefined)
    const workflows = buildWorkflows(modules, deps, known(DEFAULT_ROUTES, routes))
    expect(workflows.map((w) => w.workflow.id)).toContain('alpha')
    const inputs = { [EVAL_RUN_ID]: {}, [EVAL_COMPARE_ID]: { a: 'a'.repeat(8), b: 'b'.repeat(8) } }
    for (const [id, rest] of Object.entries(inputs)) {
      const evalInput = workflows.find((w) => w.workflow.id === id)?.workflow.input
      expect(evalInput?.safeParse({ workflow: 'alpha', ...rest }).success).toBe(true)
      expect(evalInput?.safeParse({ workflow: 'nope', ...rest }).success).toBe(false)
    }
  })

  test('the host tree builds against the default route table', async () => {
    expect((await createWorkflows(deps)).map((w) => w.workflow.id)).toContain('smoke.ping')
  })

  test('a duplicate workflow id fails, naming both files', async () => {
    const modules = await discoverWorkflowModules(at('dup-workflow'))
    expect(() => buildWorkflows(modules, deps, () => true)).toThrow(
      `${at('dup-workflow/b/module.ts')}: workflow "same" is already registered by ${at('dup-workflow/a/module.ts')}`,
    )
  })

  test('an agent on an unknown route fails, naming the file and the route', async () => {
    const modules = await discoverWorkflowModules(at('unknown-route'))
    expect(() => buildWorkflows(modules, deps, known(DEFAULT_ROUTES))).toThrow(
      `${at('unknown-route/ghost/module.ts')}: workflow "ghost" runs agent "ghost" on unknown route "ghost.agent"`,
    )
  })

  test('a default export that is not a module, an id that is not its directory, an empty dir: each fails', async () => {
    expect(await rejection(discoverWorkflowModules(at('bad-export')))).toContain(
      `${at('bad-export/x/module.ts')}: default export is not a defineWorkflowModule`,
    )
    expect(await rejection(discoverWorkflowModules(at('bad-id')))).toContain(
      `${at('bad-id/y/module.ts')}: id "not-y" is not its directory "y"`,
    )
    const empty = mkdtempSync(join(tmpdir(), 'agw-registry-'))
    expect(await rejection(discoverWorkflowModules(empty))).toContain(`no */module.ts under ${empty}`)
    expect(await rejection(discoverRoutes(empty))).toContain(`no route group under ${empty}`)
  })
})

test('a tree without suites builds no eval commands instead of failing on an empty enum', async () => {
  const evalModule = (await hostModules()).find((m) => m.id === 'eval')
  const [ghost] = await discoverWorkflowModules(at('unknown-route'))
  if (!evalModule || !ghost) throw new Error('fixture missing')
  const ids = buildWorkflows([evalModule, ghost], deps, () => true).map((w) => w.workflow.id)
  expect(ids).toEqual(['ghost'])
})

describe('route discovery', () => {
  test('a file in the table directory other than _shared.ts is a group: a stray one fails, naming it', async () => {
    expect(await rejection(discoverRoutes(at('stray-route')))).toContain(
      `${at('stray-route/_draft.ts')}: default export is not an object of routes`,
    )
  })

  test('a duplicate route id fails, naming both files', async () => {
    expect(await rejection(discoverRoutes(at('dup-route')))).toContain(
      `${at('dup-route/b.ts')}: route "same.route" is already declared by ${at('dup-route/a.ts')}`,
    )
  })
})
