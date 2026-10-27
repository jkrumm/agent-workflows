import { expect, test } from 'bun:test'
import * as elysia from '../src/elysia.ts'
import * as hono from '../src/hono.ts'
import * as orpc from '../src/orpc.ts'

for (const [name, fw] of Object.entries({ orpc, elysia, hono })) {
  test(`${name}: quick run finishes inline`, async () => {
    const res = await fw.fetch(
      new Request('http://localhost/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: 'abc def', depth: 'quick' }),
      }),
    )
    expect(res.status).toBe(200)
    expect(((await res.json()) as { status: string }).status).toBe('done')
  })
  test(`${name}: unknown run is a typed 404`, async () => {
    const res = await fw.fetch(new Request('http://localhost/runs/nope'))
    expect(res.status).toBe(404)
  })
}
