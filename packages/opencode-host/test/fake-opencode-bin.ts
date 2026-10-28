// `opencode` stand-in for the supervisor tests: `bun fake-opencode-bin.ts serve --hostname 127.0.0.1 --port <n>`.
// State lives in `$XDG_DATA_HOME/fake-state.json`; the env it was started with goes to `fake-env.json` (names only).
// `POST /__fake/hang` (no auth) wedges it: nothing answers any more and SIGTERM is ignored, like a boot stall.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { startFake } from './fake-opencode.ts'

const args = process.argv.slice(2)
if (args[0] === '--version') {
  console.log('opencode v2.0.32')
  process.exit(0)
}
const port = Number(args[args.indexOf('--port') + 1])
const data = process.env.XDG_DATA_HOME as string
writeFileSync(join(data, 'fake-env.json'), JSON.stringify(Object.keys(process.env).sort()))
writeFileSync(
  join(data, 'fake-env-values.json'),
  JSON.stringify({ OPENCODE_DISABLE_FILEWATCHER: process.env.OPENCODE_DISABLE_FILEWATCHER, HOME: process.env.HOME }),
)
const fake = startFake({
  password: process.env.OPENCODE_SERVER_PASSWORD as string,
  statePath: join(data, 'fake-state.json'),
  defaultTurnMs: 300,
})
let hung = false
process.on('SIGTERM', () => {
  if (!hung) process.exit(0)
})
// A front door on the real port: `/__fake/hang` without auth, everything else proxied to the fake.
Bun.serve({
  port,
  hostname: '127.0.0.1',
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === '/__fake/hang') {
      hung = true
      fake.hang()
      return new Response('hung')
    }
    if (hung) return new Promise<Response>(() => {})
    return fetch(`${fake.url}${url.pathname}${url.search}`, {
      method: req.method,
      headers: req.headers,
      body: req.body,
    })
  },
})
console.log(`server listening on http://127.0.0.1:${port}`)
