import { afterAll, beforeAll, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** scripts/live-routes.sh against stand-ins for agw, psql and secrets-run: the selection, the checks and the verdict. */
const SCRIPT = join(import.meta.dir, '../../../scripts/live-routes.sh')

const ROUTES = {
  routes: {
    'a.claude': { wire: 'anthropic', model: 'haiku' },
    'b.agent': { wire: 'opencode', model: 'agent-model' },
    'c.text': { wire: 'iu-openai', model: 'text-model' },
    'd.media': { wire: 'iu-openai', model: 'image-model', price: { kind: 'flat' } },
    'e.tts': { wire: 'iu-gemini', model: 'tts-model' },
    'f.decide': { wire: 'iu-decision', model: 'decide-model' },
  },
}

let dir: string
let bin: string
let root: string

/** A stand-in deployed release: the file live-routes.sh reads CLAUDE_ALIASES from, under <root>/current. */
function writeRelease(releaseRoot: string, source: string) {
  const table = join(releaseRoot, 'current', 'packages', 'routes', 'src', 'table')
  mkdirSync(table, { recursive: true })
  writeFileSync(join(table, 'claude.ts'), source)
}
const aliases = (map: Record<string, string>) => `export const CLAUDE_ALIASES = ${JSON.stringify(map)}\n`
const stub = (name: string, body: string) => {
  writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`)
  chmodSync(join(bin, name), 0o755)
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'agw-live-routes-'))
  bin = join(dir, 'bin')
  Bun.spawnSync(['mkdir', bin])
  root = join(dir, 'release')
  writeRelease(root, aliases({ haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5' }))
  writeFileSync(join(dir, 'routes.json'), JSON.stringify(ROUTES))
  stub('secrets-run', 'echo not-a-real-secret')
  // agw routes | agw smoke route <id> | agw run wait. A route named in BAD_AGW fails its call.
  stub(
    'agw',
    `case "$1" in
  routes) cat "${join(dir, 'routes.json')}" ;;
  smoke) case " $BAD_AGW " in *" $3 "*) echo "boom" >&2; exit 1 ;; esac
         echo "$3" >> "${join(dir, 'calls.log')}"
         echo "{\\"runId\\":\\"run-$3\\",\\"status\\":\\"done\\",\\"output\\":{}}" ;;
  *) exit 2 ;;
esac`,
  )
  // psql reads the SQL on stdin and the run id from -v run=...; NO_GATEWAY lists the runs without a gateway row.
  stub(
    'psql',
    `run=""; for a in "$@"; do case "$a" in run=*) run="\${a#run=}" ;; model=*) echo "\${a#model=}" >> "${join(dir, 'models.log')}" ;; esac; done
sql=$(cat)
echo "$PGCONNECT_TIMEOUT $PGOPTIONS" >> "${join(dir, 'bounds.log')}"
case "$sql" in *"count(*)"*) printf '%s\\n' "$sql" >> "${join(dir, 'sql.log')}" ;; esac
case "$sql" in
  *"from usage.records"*"count(*)"*|*"count(*)"*"from usage.records"*)
    case " $NO_GATEWAY " in *" $run "*) echo "0|||0|0|0|" ;; *) echo "1|api_credit|pool-a|120|20|8|0.000321" ;; esac ;;
  *"string_agg(coalesce(model"*) echo "other-model lane=agw_workflow cost=null" ;;
  *) echo "done|0.000321" ;;
esac`,
  )
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

async function run(args: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn(['/bin/zsh', SCRIPT, ...args], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, AGW_ROOT: root, LIVE_ROUTES_POLL_SECS: '0', ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  return { code: await proc.exited, stdout, stderr }
}

test('by default it probes the anthropic, opencode and iu-openai text routes, and prints the table', async () => {
  writeFileSync(join(dir, 'calls.log'), '')
  const result = await run([])
  expect(result.code).toBe(0)
  const called = (await Bun.file(join(dir, 'calls.log')).text()).trim().split('\n').sort()
  expect(called).toEqual(['a.claude', 'b.agent', 'c.text'])
  expect(result.stdout).toContain('route')
  expect(result.stdout).toContain('cache read')
  expect(result.stdout).toMatch(
    /a\.claude\s+claude-haiku-5-5\s+api_credit\s+pool-a\s+120\s+20\s+8\s+0\.000321\s+run-a\.claude/,
  )
  expect(result.stdout).toContain('PASS 3 routes')
  expect(result.stdout + result.stderr).not.toContain('not-a-real-secret')
})

test('a named route runs alone; a media route is refused before any call', async () => {
  writeFileSync(join(dir, 'calls.log'), '')
  const one = await run(['c.text'])
  expect(one.code).toBe(0)
  expect((await Bun.file(join(dir, 'calls.log')).text()).trim()).toBe('c.text')
  for (const media of ['d.media', 'e.tts', 'f.decide', 'nope']) {
    const refused = await run([media])
    expect(refused.code).toBe(1)
    expect(refused.stderr).toContain('not a probeable route')
  }
})

test('a failed call or a missing gateway row fails that route, by name, and the exit is non-zero', async () => {
  const result = await run([], { BAD_AGW: 'b.agent', NO_GATEWAY: 'run-c.text' })
  expect(result.code).toBe(1)
  expect(result.stderr).toContain('FAIL b.agent: agw smoke route exited 1')
  expect(result.stderr).toContain("FAIL c.text: no source='gateway' row with outcome ok, model text-model")
  expect(result.stderr).not.toContain('FAIL a.claude')
  expect(result.stderr).toContain('2 of 3 routes failed')
})

test('the gateway row must be outcome ok with the served model; an alias resolves to the concrete id', async () => {
  for (const f of ['models.log', 'sql.log', 'bounds.log']) writeFileSync(join(dir, f), '')
  const result = await run(['a.claude'])
  expect(result.code).toBe(0)
  const models = (await Bun.file(join(dir, 'models.log')).text()).trim().split('\n')
  expect(new Set(models)).toEqual(new Set(['claude-haiku-5-5']))
  const sql = await Bun.file(join(dir, 'sql.log')).text()
  expect(sql).toContain("outcome = 'ok'")
  expect(sql).toContain("model = :'model'")
  expect(sql).not.toContain('model_raw')
})

test('every psql call has a connect and a statement timeout under the polling deadline', async () => {
  writeFileSync(join(dir, 'bounds.log'), '')
  const result = await run(['c.text'], { LIVE_ROUTES_POLL_SECS: '3' })
  expect(result.code).toBe(0)
  const lines = (await Bun.file(join(dir, 'bounds.log')).text()).trim().split('\n')
  expect(lines.length).toBeGreaterThan(0)
  for (const line of lines) expect(line).toBe('3 -c statement_timeout=3000')
})

test('a route given twice is refused before any call', async () => {
  writeFileSync(join(dir, 'calls.log'), '')
  const result = await run(['c.text', 'c.text'])
  expect(result.code).toBe(1)
  expect(result.stderr).toContain('c.text is given more than once')
  expect((await Bun.file(join(dir, 'calls.log')).text()).trim()).toBe('')
})

test('a route whose model is an alias is compared against the alias target of the release under test', async () => {
  const other = join(dir, 'other-release')
  writeRelease(other, aliases({ haiku: 'claude-haiku-9-9' }))
  writeFileSync(join(dir, 'models.log'), '')
  const result = await run(['a.claude'], { AGW_ROOT: other })
  expect(result.code).toBe(0)
  const models = (await Bun.file(join(dir, 'models.log')).text()).trim().split('\n')
  expect(new Set(models)).toEqual(new Set(['claude-haiku-9-9']))
  expect(result.stdout).toMatch(/a\.claude\s+claude-haiku-9-9\s/)
  // a model that is not an alias is compared as it is
  writeFileSync(join(dir, 'models.log'), '')
  await run(['c.text'], { AGW_ROOT: other })
  expect(new Set((await Bun.file(join(dir, 'models.log')).text()).trim().split('\n'))).toEqual(new Set(['text-model']))
})

test('a missing or malformed alias map fails loudly before any call, never falls back', async () => {
  writeFileSync(join(dir, 'calls.log'), '')
  const missing = await run(['a.claude'], { AGW_ROOT: join(dir, 'no-such-release') })
  expect(missing.code).toBe(1)
  expect(missing.stderr).toContain('the alias map source')
  expect(missing.stderr).toContain('is missing')
  const noExport = join(dir, 'no-export-release')
  writeRelease(noExport, 'export const OTHER = {}\n')
  const notExported = await run(['a.claude'], { AGW_ROOT: noExport })
  expect(notExported.code).toBe(1)
  expect(notExported.stderr).toContain('cannot read CLAUDE_ALIASES')
  const empty = join(dir, 'empty-release')
  writeRelease(empty, aliases({}))
  const emptyMap = await run(['a.claude'], { AGW_ROOT: empty })
  expect(emptyMap.code).toBe(1)
  expect(emptyMap.stderr).toContain('not a non-empty map of strings')
  expect((await Bun.file(join(dir, 'calls.log')).text()).trim()).toBe('')
})
