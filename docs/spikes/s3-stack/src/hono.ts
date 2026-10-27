import { createRoute, OpenAPIHono } from '@hono/zod-openapi'
import { streamSSE } from 'hono/streaming'
import { z } from 'zod'
import {
  assertRun,
  ErrorBody,
  getRun,
  progress,
  RunIdParam,
  RunInput,
  RunNotFoundError,
  RunResponse,
  RunStatus,
  startRun,
  XCliRun,
  XCliStatus,
} from './shared.ts'

const json = <T extends z.ZodType>(schema: T, description: string) => ({ description, content: { 'application/json': { schema } } })

const runRoute = createRoute({
  method: 'post',
  path: '/run',
  operationId: 'researchRun',
  summary: 'Run research.report',
  'x-cli': XCliRun,
  request: { body: { required: true, content: { 'application/json': { schema: RunInput } } } },
  responses: { 200: json(RunResponse, 'Finished, or pending with a resume handle') },
})
const statusRoute = createRoute({
  method: 'get',
  path: '/runs/{runId}',
  operationId: 'runStatus',
  summary: 'Run status',
  'x-cli': XCliStatus,
  request: { params: RunIdParam },
  responses: { 200: json(RunStatus, 'Run state'), 404: json(ErrorBody, 'Run not found') },
})
const eventsRoute = createRoute({
  method: 'get',
  path: '/runs/{runId}/events',
  operationId: 'runEvents',
  summary: 'Progress events (SSE)',
  request: { params: RunIdParam },
  responses: {
    200: { description: 'text/event-stream of progress events', content: { 'text/event-stream': { schema: z.string() } } },
    404: json(ErrorBody, 'Run not found'),
  },
})

export const app = new OpenAPIHono()
  .openapi(runRoute, async (c) => c.json(await startRun(c.req.valid('json')), 200))
  .openapi(statusRoute, (c) => {
    try {
      return c.json(getRun(c.req.valid('param').runId), 200)
    } catch (e) {
      if (e instanceof RunNotFoundError) return c.json({ error: { kind: 'not_found' as const, message: e.message, runId: e.runId } }, 404)
      throw e
    }
  })
  .openapi(eventsRoute, (c) => {
    const { runId } = c.req.valid('param')
    // decide the status before the first byte: streamSSE has already committed 200 once it starts
    try {
      assertRun(runId)
    } catch (e) {
      if (e instanceof RunNotFoundError) return c.json({ error: { kind: 'not_found' as const, message: e.message, runId: e.runId } }, 404) as never
      throw e
    }
    return streamSSE(c, async (stream) => {
      for await (const e of progress(runId)) await stream.writeSSE({ data: JSON.stringify(e) })
    }) as never
  })

export const fetch = (req: Request) => app.fetch(req)
export const spec = () => app.getOpenAPI31Document({ openapi: '3.1.0', info: { title: 'Hono', version: '0.0.0' } })

// import: Hono has no in-process call of a route; the closest is app.request (a synthetic Request)
export const inProcess = async (input: unknown) => {
  const res = await app.request('/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })
  return { status: res.status, body: await res.json() }
}
