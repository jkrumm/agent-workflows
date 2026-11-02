// A host on a real socket that serves the contract v1 shape: the real capabilities registry's
// OpenAPI document and routes, plus fixture workflow and run operations. The CLI under test only
// ever sees HTTP, so this file is the whole of what it is checked against.
import { createHash } from 'node:crypto'
import { createCapabilities, createRegistry } from '@agent-workflows/capabilities'
import { fakeTransports } from '@agent-workflows/capabilities/testing'

type Json = Record<string, unknown>
type Status = 'pending' | 'running' | 'done' | 'failed' | 'cancelled'

export interface Recorded {
  method: string
  path: string
  headers: Record<string, string>
  body: unknown
}

export interface Workflow {
  id: string
  summary: string
  input: Json
  /** The workflow's own output schema, written into the run state of its response as the real host does. */
  output?: Json
  mutating?: boolean
  plainField?: string
  stdin?: string
  positional?: string[]
  /** Overrides `x-cli.kind`, to serve one the CLI does not know. */
  kind?: string
  /** Leaves `x-cli.resume` out. */
  noResume?: boolean
  /** Runs inline when absent; `{ durationS, fail }` drive the fixture's run, `respond` replaces the answer. */
  outcome?: (input: Json) => { durationS?: number; fail?: string; output?: unknown; respond?: Response }
}

export interface Run {
  runId: string
  workflowId: string
  endsAt: number
  fail?: string
  output: unknown
  cancelled: boolean
  key?: string
  input: string
}

const errorBody = (code: string, status: number, message: string, data?: unknown) =>
  Response.json({ defined: false, code, status, message, ...(data === undefined ? {} : { data }) }, { status })

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((k) => [k, canonical((value as Json)[k])]),
  )
}

/** Contract v1: sha256 hex of the canonical JSON of the document without `info['x-contract-sha']`. */
export function hostSha(doc: Json): string {
  const { 'x-contract-sha': _, ...info } = (doc.info ?? {}) as Json
  return createHash('sha256')
    .update(JSON.stringify(canonical({ ...doc, info })))
    .digest('hex')
}

const runState = { $ref: '#/components/schemas/RunState' }
const runStateSchema = {
  type: 'object',
  properties: {
    runId: { type: 'string' },
    workflowId: { type: 'string' },
    status: { enum: ['pending', 'running', 'done', 'failed', 'cancelled'] },
    output: {},
    error: { type: 'object', properties: { kind: { type: 'string' }, message: { type: 'string' } } },
  },
  required: ['runId', 'workflowId', 'status'],
}
const runResponses = {
  '200': { content: { 'application/json': { schema: runState } } },
  '202': { content: { 'application/json': { schema: runState } } },
}
// Parameters and request bodies by `$ref`, as OpenAPI allows: the CLI must dereference them.
const runParam = [{ $ref: '#/components/parameters/RunId' }]
const runX = (command: string[], mutating = false) => ({
  command,
  positional: ['runId'],
  mutating,
  defaultFormat: 'json',
  kind: 'run',
})

export const FIXTURE_WORKFLOWS: Workflow[] = [
  {
    id: 'fixture.echo',
    summary: 'Echo the message after durationS seconds',
    output: {
      type: 'object',
      properties: {
        echo: { type: 'string' },
        mode: { enum: ['plain', 'fancy'] },
        tags: { $ref: '#/components/schemas/Tags' },
      },
      required: ['echo', 'mode'],
    },
    input: {
      type: 'object',
      properties: {
        message: { type: 'string', minLength: 1, description: 'What to echo' },
        durationS: { type: 'number', default: 0 },
        times: { type: 'integer', default: 1 },
        loud: { type: 'boolean', default: false },
        mode: { enum: ['plain', 'fancy'], default: 'plain' },
        tags: { $ref: '#/components/schemas/Tags' },
        level: { anyOf: [{ const: 'low' }, { const: 'high' }, { type: 'null' }] },
        size: { anyOf: [{ type: 'string' }, { type: 'number' }] },
      },
      required: ['message'],
    },
    positional: ['message'],
    stdin: 'message',
    plainField: 'echo',
    outcome: (input) => {
      const text = String(input.message).repeat(Number(input.times ?? 1))
      return {
        durationS: Number(input.durationS ?? 0),
        output: { echo: input.loud ? text.toUpperCase() : text, mode: input.mode ?? 'plain', tags: input.tags ?? null },
      }
    },
  },
  {
    id: 'fixture.note',
    summary: 'An optional field read from stdin',
    input: { type: 'object', properties: { text: { type: 'string' } } },
    stdin: 'text',
    outcome: (input) => ({ output: { text: input.text ?? null } }),
  },
  {
    id: 'fixture.norunid',
    summary: 'Answers 202 without a run id',
    input: { type: 'object', properties: {} },
    outcome: () => ({ respond: Response.json({ status: 'running' }, { status: 202 }) }),
  },
  {
    id: 'fixture.dotrun',
    summary: 'Answers 202 with an unsafe run id',
    input: { type: 'object', properties: {} },
    outcome: () => ({
      respond: Response.json({ runId: '..', workflowId: 'fixture.dotrun', status: 'running' }, { status: 202 }),
    }),
  },
  {
    id: 'fixture.noresume',
    summary: 'A workflow without x-cli.resume',
    input: { type: 'object', properties: {} },
    noResume: true,
    outcome: () => ({ durationS: 5 }),
  },
  {
    id: 'fixture.fail',
    summary: 'A run that ends failed',
    input: { type: 'object', properties: {} },
    plainField: 'echo',
    outcome: () => ({ fail: 'the fixture always fails' }),
  },
  {
    id: 'fixture.deploy',
    summary: 'A mutating workflow',
    input: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] },
    mutating: true,
    outcome: (input) => ({ output: { deployed: input.target } }),
  },
  {
    id: 'fixture.limited',
    summary: 'Always rate limited',
    input: { type: 'object', properties: {} },
    outcome: () => ({
      respond: new Response(
        JSON.stringify({ defined: false, code: 'RATE_LIMITED', status: 429, message: 'slow down' }),
        {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': '7' },
        },
      ),
    }),
  },
  {
    id: 'fixture.boom',
    summary: 'Always a 500',
    input: { type: 'object', properties: {} },
    outcome: () => ({ respond: errorBody('INTERNAL_SERVER_ERROR', 500, 'Internal server error') }),
  },
]

/** The run state with this workflow's output in place of the open `output`. */
function typedResponses(output: Json | undefined) {
  if (!output) return runResponses
  const schema = { ...runStateSchema, properties: { ...runStateSchema.properties, output } }
  return {
    '200': { content: { 'application/json': { schema } } },
    '202': { content: { 'application/json': { schema } } },
  }
}

function workflowOperation(w: Workflow) {
  return {
    operationId: w.id.replace(/\.(\w)/g, (_, c: string) => c.toUpperCase()),
    summary: w.summary,
    requestBody: w.mutating
      ? { $ref: `#/components/requestBodies/${w.id.replace('.', '_')}` }
      : { required: true, content: { 'application/json': { schema: w.input } } },
    responses: typedResponses(w.output),
    'x-cli': {
      command: w.id.split('.'),
      positional: w.positional ?? [],
      mutating: w.mutating ?? false,
      defaultFormat: 'json',
      ...(w.stdin ? { stdin: w.stdin } : {}),
      ...(w.plainField ? { plainField: w.plainField } : {}),
      kind: w.kind ?? 'workflow',
      ...(w.noResume ? {} : { resume: { command: ['run', 'wait'], positional: ['runId'] } }),
    },
  }
}

/** The shared Postgres journal, as two fakes see it: every process answers for every run. */
export type RunStore = Map<string, Run>

export interface FakeHostOptions {
  /** The fixture workflows this process serves; default {@link FIXTURE_WORKFLOWS}. */
  workflows?: Workflow[]
  /** Serve the capabilities registry; default true. A second process serves only its own workflows and the run ops. */
  capabilities?: boolean
  /** One store passed to two fakes is one journal. */
  runs?: RunStore
  /** Replaces the run id's schema: a process whose run operations drifted from the host's. */
  runIdSchema?: Json
}

export interface FakeHost {
  url: string
  secret: string
  requests: Recorded[]
  sha: () => string
  document: () => Json
  addWorkflow: (w: Workflow) => void
  removeWorkflow: (id: string) => void
  /** Changes the served sha without changing any command. */
  bumpVersion: () => void
  /** Serves `body` as /openapi.json instead of the document (undefined restores it). */
  serveDocument: (body: unknown) => void
  /** Delays every `GET /runs/{runId}` by this many ms. */
  slowStatus: (ms: number) => void
  stop: () => Promise<void>
}

export async function startFakeHost(options: FakeHostOptions = {}): Promise<FakeHost> {
  const secret = 'conformance-secret-0123456789abcdef'
  const registry = createRegistry(
    createCapabilities({
      transports: fakeTransports({
        anthropic: [(r) => ({ text: `Title: ${/<text>\n([\s\S]*)\n<\/text>/.exec(r.prompt)?.[1] ?? ''}` })],
      }),
    }),
  )
  const capabilityDoc = options.capabilities === false ? { paths: {} } : ((await registry.openapi()) as Json)
  const workflows = new Map((options.workflows ?? FIXTURE_WORKFLOWS).map((w) => [w.id, w]))
  const runs: RunStore = options.runs ?? new Map()
  const requests: Recorded[] = []
  let version = 1
  let override: unknown
  let statusDelayMs = 0

  const build = (): Json => {
    const paths: Json = {}
    for (const [path, item] of Object.entries(capabilityDoc.paths as Json)) {
      paths[path] = Object.fromEntries(
        Object.entries(item as Json).map(([m, op]) => [
          m,
          { ...(op as Json), 'x-cli': { ...((op as Json)['x-cli'] as Json), kind: 'capability' } },
        ]),
      )
    }
    for (const w of workflows.values())
      paths[`/workflows/${w.id.split('.').join('/')}`] = { post: workflowOperation(w) }
    paths['/runs/{runId}'] = {
      get: {
        operationId: 'runStatus',
        summary: 'Run state',
        parameters: runParam,
        responses: runResponses,
        'x-cli': runX(['run', 'status']),
      },
    }
    paths['/runs/{runId}/wait'] = {
      post: {
        operationId: 'runWait',
        summary: 'Wait for a run',
        parameters: runParam,
        responses: runResponses,
        'x-cli': runX(['run', 'wait']),
      },
    }
    paths['/runs/{runId}/cancel'] = {
      post: {
        operationId: 'runCancel',
        summary: 'Cancel a run',
        parameters: runParam,
        responses: runResponses,
        'x-cli': runX(['run', 'cancel'], true),
      },
    }
    const doc: Json = {
      openapi: '3.1.1',
      info: { title: 'agent-workflows host', version: `0.0.${version}` },
      paths,
      components: {
        schemas: { RunState: runStateSchema, Tags: { type: 'object', additionalProperties: { type: 'string' } } },
        parameters: {
          RunId: { name: 'runId', in: 'path', required: true, schema: options.runIdSchema ?? { type: 'string' } },
        },
        requestBodies: Object.fromEntries(
          [...workflows.values()]
            .filter((w) => w.mutating)
            .map((w) => [
              w.id.replace('.', '_'),
              { required: true, content: { 'application/json': { schema: w.input } } },
            ]),
        ),
      },
    }
    ;(doc.info as Json)['x-contract-sha'] = hostSha(doc)
    return doc
  }
  let doc = build()
  const served = () => (doc.info as Json)['x-contract-sha'] as string

  const status = (run: Run): Status => {
    if (run.cancelled) return 'cancelled'
    if (Date.now() < run.endsAt) return 'running'
    return run.fail ? 'failed' : 'done'
  }
  const reply = (run: Run) => {
    const s = status(run)
    const body = {
      runId: run.runId,
      workflowId: run.workflowId,
      status: s,
      ...(s === 'done' ? { output: run.output } : {}),
      ...(s === 'failed' ? { error: { kind: 'step', message: run.fail } } : {}),
    }
    return Response.json(body, { status: s === 'done' || s === 'failed' || s === 'cancelled' ? 200 : 202 })
  }
  const waitFor = async (run: Run, request: Request) => {
    const match = /wait=(\d+)/.exec(request.headers.get('prefer') ?? '')
    const until = Date.now() + Math.min(Number(match?.[1] ?? 0), 240) * 1000
    while (status(run) === 'running' && Date.now() < until) await Bun.sleep(Math.min(50, until - Date.now()))
    return reply(run)
  }

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    idleTimeout: 60,
    async fetch(request) {
      const url = new URL(request.url)
      const text = request.method === 'GET' ? '' : await request.clone().text()
      requests.push({
        method: request.method,
        path: url.pathname,
        headers: Object.fromEntries(request.headers.entries()),
        body: text ? JSON.parse(text) : undefined,
      })
      if (url.pathname === '/health') return Response.json({ status: 'ok', version: '0.0.0' })
      if (request.headers.get('authorization') !== `Bearer ${secret}`)
        return errorBody('UNAUTHORIZED', 401, 'Unauthorized')
      const client = request.headers.get('x-agw-contract')
      if (client !== null && client !== served())
        return errorBody('CONTRACT_MISMATCH', 412, 'Contract mismatch', { server: served(), client })
      if (url.pathname === '/openapi.json') return Response.json(override ?? doc)

      const runPath = /^\/runs\/([^/]+)(\/wait|\/cancel)?$/.exec(url.pathname)
      if (runPath) {
        const run = runs.get(decodeURIComponent(runPath[1] as string))
        if (!run) return errorBody('NOT_FOUND', 404, 'Run not found')
        if (runPath[2] === '/wait' && request.method === 'POST') return waitFor(run, request)
        if (runPath[2] === '/cancel' && request.method === 'POST') {
          if (status(run) === 'running') run.cancelled = true
          return reply(run)
        }
        if (!runPath[2] && request.method === 'GET') {
          await Bun.sleep(statusDelayMs)
          return reply(run)
        }
      }

      const wf = url.pathname.startsWith('/workflows/') && workflows.get(url.pathname.slice(11).split('/').join('.'))
      if (wf && request.method === 'POST') {
        const input = (text ? JSON.parse(text) : {}) as Json
        const required = ((wf.input.required ?? []) as string[]).filter(
          (k) => input[k] === undefined || input[k] === '',
        )
        if (required.length) return errorBody('BAD_REQUEST', 400, `Input validation failed: ${required.join(', ')}`)
        const key = request.headers.get('idempotency-key') ?? undefined
        const existing = key ? [...runs.values()].find((r) => r.key === key && r.workflowId === wf.id) : undefined
        if (existing && existing.input !== text)
          return errorBody('CONFLICT', 409, 'Idempotency-Key reused with another input')
        if (existing) return waitFor(existing, request)
        const outcome = wf.outcome?.(input) ?? {}
        if (outcome.respond) return outcome.respond
        const run: Run = {
          runId: crypto.randomUUID(),
          workflowId: wf.id,
          endsAt: Date.now() + (outcome.durationS ?? 0) * 1000,
          fail: outcome.fail,
          output: outcome.output ?? {},
          cancelled: false,
          key,
          input: text,
        }
        runs.set(run.runId, run)
        return waitFor(run, request)
      }
      if (options.capabilities === false) return errorBody('NOT_FOUND', 404, 'Not found')
      return registry.fetch(request)
    },
  })

  const rebuild = () => {
    doc = build()
  }
  return {
    url: `http://127.0.0.1:${server.port}`,
    secret,
    requests,
    sha: served,
    document: () => doc,
    addWorkflow: (w) => {
      workflows.set(w.id, w)
      rebuild()
    },
    removeWorkflow: (id) => {
      workflows.delete(id)
      rebuild()
    },
    bumpVersion: () => {
      version++
      rebuild()
    },
    serveDocument: (body) => {
      override = body
    },
    slowStatus: (ms) => {
      statusDelayMs = ms
    },
    stop: () => server.stop(true),
  }
}
