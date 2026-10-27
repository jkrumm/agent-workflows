import { OpenAPIGenerator } from '@orpc/openapi'
import { OpenAPIHandler } from '@orpc/openapi/fetch'
import { call, eventIterator, ORPCError, os } from '@orpc/server'
import { ZodToJsonSchemaConverter } from '@orpc/zod/zod4'
import type { z } from 'zod'
import {
  getRun,
  ProgressEvent,
  progress,
  RunIdParam,
  RunInput,
  RunNotFound,
  RunNotFoundError,
  RunResponse,
  RunStatus,
  startRun,
  XCliRun,
  XCliStatus,
} from './shared.ts'

const errors = { RUN_NOT_FOUND: { status: 404, message: 'Run not found', data: RunNotFound } }
// concept §4: middleware wraps every call. The counter proves it runs for import-style calls too, not only HTTP.
export const stats = { middleware: 0 }
const base = os.errors(errors).use(({ next }) => {
  stats.middleware++
  return next()
})
const notFound = (e: unknown): never => {
  if (e instanceof RunNotFoundError) throw new ORPCError('RUN_NOT_FOUND', { status: 404, message: e.message, data: { runId: e.runId } })
  throw e
}

export const run = base
  .route({ method: 'POST', path: '/run', operationId: 'researchRun', summary: 'Run research.report', spec: (s) => ({ ...s, 'x-cli': XCliRun }) })
  .input(RunInput)
  .output(RunResponse)
  .handler(({ input }) => startRun(input))

export const runStatus = base
  .route({ method: 'GET', path: '/runs/{runId}', operationId: 'runStatus', summary: 'Run status', spec: (s) => ({ ...s, 'x-cli': XCliStatus }) })
  .input(RunIdParam)
  .output(RunStatus)
  .handler(({ input }) => {
    try {
      return getRun(input.runId)
    } catch (e) {
      return notFound(e)
    }
  })

export const runEvents = base
  .route({ method: 'GET', path: '/runs/{runId}/events', operationId: 'runEvents', summary: 'Progress events (SSE)' })
  .input(RunIdParam)
  .output(eventIterator(ProgressEvent))
  .handler(async function* ({ input }) {
    try {
      yield* progress(input.runId)
    } catch (e) {
      notFound(e)
    }
  })

export const router = { run, runStatus, runEvents }

const handler = new OpenAPIHandler(router)
export const fetch = async (req: Request) => (await handler.handle(req)).response ?? new Response('not matched', { status: 404 })

export const spec = () =>
  new OpenAPIGenerator({ schemaConverters: [new ZodToJsonSchemaConverter()] }).generate(router, { info: { title: 'oRPC', version: '0.0.0' } })

// import: same definition, no HTTP, input validated + defaults applied
export const inProcess = (input: z.input<typeof RunInput>) => call(run, input)
