import { describe, expect, test } from 'bun:test'
import { READ_ONLY_TOOLS } from './allowlist.ts'
import { createHdxCapabilities } from './index.ts'

// HyperDX only, no money. Opt in with the environments to reach (comma-separated):
//   AGW_LIVE_HDX=local,prod secrets-run run --env-file=.env.tpl -- bun test packages/capabilities/src/hdx/hdx.live.test.ts
// `local` needs ClickStack running on this host; `prod` needs HYPERDX_PROD_ACCESS_KEY and HYPERDX_DOMAIN. Counts only.
const wanted = (process.env.AGW_LIVE_HDX ?? '').split(',').map((s) => s.trim())
const [tools, , query] = createHdxCapabilities()

for (const env of ['local', 'prod'] as const) {
  describe.skipIf(!wanted.includes(env))(`live hdx (${env})`, () => {
    test('the allowlist matches the server annotations, and a read query answers', async () => {
      const { tools: list } = await tools.call({ env })
      const serverReadOnly = list.filter((t) => t.readOnlyHint === true).map((t) => t.name)
      console.log(
        `live hdx ${env}: ${list.length} tools, ${serverReadOnly.length} annotated read-only, ${list.filter((t) => t.readOnly).length} accepted by hdx.query`,
      )
      // Drift both ways: a read-only tool the allowlist does not name yet, and an allowlisted tool the server no longer calls read-only.
      expect(serverReadOnly.filter((name) => !(READ_ONLY_TOOLS as readonly string[]).includes(name))).toEqual([])
      expect(list.filter((t) => t.readOnly && t.readOnlyHint !== true).map((t) => t.name)).toEqual([])

      const sources = await query.call({ env, tool: 'clickstack_list_sources' })
      expect(sources.isError).toBe(false)
      const parsed: unknown = JSON.parse(sources.text)
      const items = Array.isArray(parsed) ? parsed : (parsed as { sources?: unknown[] }).sources
      console.log(
        `live hdx ${env}: clickstack_list_sources -> ${items?.length ?? 'n/a'} sources, ${sources.totalChars} chars`,
      )
    }, 60_000)
  })
}
