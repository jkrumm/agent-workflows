import { openapi } from '@elysia/openapi'
import { Elysia, sse, status } from 'elysia'
import { ErrorBody, getRun, progress, RunIdParam, RunInput, RunNotFoundError, RunResponse, RunStatus, startRun, XCliRun, XCliStatus } from './shared.ts'

const notFound = (e: unknown) => {
  if (e instanceof RunNotFoundError) return status(404, { error: { kind: 'not_found' as const, message: e.message, runId: e.runId } })
  throw e
}

export const build = (openapiOptions: Partial<Parameters<typeof openapi>[0]> = {}) =>
  new Elysia()
    .use(openapi({ path: '/openapi', documentation: { info: { title: 'Elysia', version: '0.0.0' } }, ...openapiOptions }))
    .post('/run', ({ body }) => startRun(body), {
      body: RunInput,
      response: { 200: RunResponse },
      detail: { operationId: 'researchRun', summary: 'Run research.report', 'x-cli': XCliRun },
    })
    .get(
      '/runs/:runId',
      ({ params }) => {
        try {
          return getRun(params.runId)
        } catch (e) {
          return notFound(e)
        }
      },
      {
        params: RunIdParam,
        response: { 200: RunStatus, 404: ErrorBody },
        detail: { operationId: 'runStatus', summary: 'Run status', 'x-cli': XCliStatus },
      },
    )
    .get(
      '/runs/:runId/events',
      async function* ({ params }) {
        try {
          for await (const e of progress(params.runId)) yield sse({ data: e })
        } catch (e) {
          notFound(e)
        }
      },
      { params: RunIdParam, detail: { operationId: 'runEvents', summary: 'Progress events (SSE)' } },
    )

export const app = build()
export const fetch = (req: Request) => app.handle(req)
export const spec = async () => (await app.handle(new Request('http://localhost/openapi/json'))).json()

// import: Elysia has no in-process call of a route; the closest is a synthetic Request through the router
export const inProcess = async (input: unknown) => {
  const res = await app.handle(
    new Request('http://localhost/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }),
  )
  return { status: res.status, body: await res.json() }
}
