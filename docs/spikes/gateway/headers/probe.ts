// Header probe: can OpenCode (pinned 2.0.32) and Hermes carry per-session gateway headers?
//   cd docs/spikes/gateway/headers && timeout 300 bun run probe.ts
// Every request goes to a loopback capture server (capture.ts); no upstream LLM is called, keys are dummies.
// OpenCode runs through scripts/opencode-safe with temp HOME/XDG dirs. Hermes runs with a temp HERMES_HOME; the live
// ~/.hermes is never read or written. HTTP(S) proxy env points at a dead port, so any non-loopback call fails fast.
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Captured, startCapture } from './capture.ts'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../../../..')
const evidence = join(here, 'evidence')
const only = process.argv[2] // optional: "opencode" | "hermes"
const cap = startCapture()
const BASE = `http://127.0.0.1:${cap.port}`
const tmp = mkdtempSync(join(tmpdir(), 'gw-header-probe-'))
const scrub = (s: string) => s.replaceAll(tmp, '<tmp>').replaceAll(homedir(), '~')
const NOISE = new Set(['accept', 'accept-encoding', 'accept-language', 'connection', 'content-length', 'host', 'content-type', 'sec-fetch-mode'])

// The pinned build by absolute path, like the host (`resolveOpencodeBinary`): the `scripts/opencode` shim reads $HOME,
// which these runs replace. `opencode-safe` execs `opencode` from PATH, so a symlink dir comes first.
const OPENCODE_BIN = join(homedir(), '.local/share/agent-workflows/opencode-bin/current/node_modules/.bin/opencode')
mkdirSync(join(tmp, 'bin'))
symlinkSync(OPENCODE_BIN, join(tmp, 'bin/opencode'))

const deadProxy = { HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', NO_PROXY: '127.0.0.1,localhost' }

function sh(cmd: string[], env: Record<string, string>, cwd: string, timeoutMs: number) {
  return new Promise<{ code: number | null; out: string }>((done) => {
    const child = spawn(cmd[0] as string, cmd.slice(1), { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    const t = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.on('close', (code) => (clearTimeout(t), done({ code, out })))
  })
}

function show(title: string, rows: Captured[], keep: (h: string) => boolean = () => true) {
  console.log(`\n--- ${title}: ${rows.length} request(s)`)
  for (const r of rows) {
    console.log(`#${r.seq} ${r.method} ${r.path}  [${r.kind}] model=${r.model}`)
    for (const [k, v] of Object.entries(r.headers).sort(([a], [b]) => (a < b ? -1 : 1)))
      if (!NOISE.has(k) && keep(k)) console.log(`    ${k}: ${scrub(v)}`)
    console.log(`    body.metadata: ${JSON.stringify(r.metadata)}  openai-identity: ${JSON.stringify(r.openaiIdentity)}`)
  }
}

const results: Record<string, Captured[]> = {}
const take = (id: string, since: number) => (results[id] = cap.log.slice(since))

// ---------- OpenCode ----------
const MODELS = {
  anthropic: { provider: 'cap-anthropic', pkg: 'aisdk:@ai-sdk/anthropic', base: `${BASE}/v1` },
  chat: { provider: 'cap-chat', pkg: 'aisdk:@ai-sdk/openai-compatible', base: `${BASE}/openai/v1` },
  responses: { provider: 'cap-responses', pkg: 'aisdk:@ai-sdk/openai', base: `${BASE}/openai/v1` },
} as const
type Leg = keyof typeof MODELS

function ocConfig(extra: { leg: Leg; headers?: boolean; body?: boolean; plugin?: boolean }[] | 'plain', plugin = false) {
  const providers: Record<string, unknown> = {}
  for (const [leg, m] of Object.entries(MODELS) as [Leg, (typeof MODELS)[Leg]][]) {
    const o = extra === 'plain' ? {} : (extra.find((e) => e.leg === leg) ?? {})
    const withHeaders = 'headers' in o && o.headers
    const withBody = 'body' in o && o.body
    providers[m.provider] = {
      package: m.pkg,
      name: `capture ${leg}`,
      settings: {
        baseURL: m.base,
        apiKey: 'dummy-key',
        ...(withHeaders ? { headers: { 'x-agw-static-settings': 'from-settings.headers' } } : {}),
      },
      ...(withHeaders ? { headers: { 'x-agw-static-provider': 'from-provider.headers' } } : {}),
      ...(withBody ? { body: leg === 'anthropic' ? { metadata: { user_id: 'static-body-user' } } : { user: 'static-body-user' } } : {}),
      models: {
        capmodel: {
          name: 'capmodel',
          ...(withHeaders ? { headers: { 'x-agw-static-model': 'from-model.headers' } } : {}),
        },
      },
    }
  }
  return {
    update: 'disable',
    share: 'disabled',
    ...(plugin ? { plugins: [join(here, 'plugin/agw-session-headers')] } : {}),
    providers,
  }
}

function ocEnv(name: string, config: unknown) {
  const root = join(tmp, name)
  const dirs = Object.fromEntries(['home', 'config', 'data', 'cache', 'state', 'project'].map((d) => [d, join(root, d)]))
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true })
  const env: Record<string, string> = {
    PATH: `${join(tmp, 'bin')}:${join(repo, 'scripts')}:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin`,
    HOME: dirs.home as string,
    TMPDIR: tmp,
    LANG: 'en_US.UTF-8',
    XDG_CONFIG_HOME: dirs.config as string,
    XDG_DATA_HOME: dirs.data as string,
    XDG_CACHE_HOME: dirs.cache as string,
    XDG_STATE_HOME: dirs.state as string,
    OPENCODE_DB: join(root, 'opencode.db'),
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    OPENCODE_DISABLE_FILEWATCHER: '1',
    OPENCODE_DISABLE_CLAUDE_CODE: '1',
    OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    // opencode-safe's reachability probe target: the capture server (answers 404 < 500 = reachable).
    IU_OPENAI_BASE: `${BASE}/openai/v1`,
    OPENCODE_SAFE_TIMEOUT: '90',
    ...deadProxy,
  }
  return { env, project: dirs.project as string }
}

const hex = (n: number) => 'ses_' + n.toString(16).padStart(64, 'a')

async function ocRun(id: string, config: unknown, legs: Leg[]) {
  const since = cap.log.length
  for (const [i, leg] of legs.entries()) {
    const { env, project } = ocEnv(`${id}-${leg}`, config)
    const sid = hex(0xc0de00 + since + i)
    const r = await sh(
      ['opencode-safe', 'run', '--standalone', '--session', sid, '--model', `${MODELS[leg].provider}/capmodel`, 'ping'],
      env,
      project,
      100_000,
    )
    console.log(`[${id}/${leg}] session=${sid.slice(0, 12)}… exit=${r.code} tail=${JSON.stringify(scrub(r.out.trim()).slice(-160))}`)
  }
  return take(id, since)
}

// The host's path: `opencode serve` + HTTP API, a client-chosen session id and `metadata`, like host.ts createSession.
async function ocServe(id: string, config: unknown) {
  const since = cap.log.length
  const { env, project } = ocEnv(id, config)
  const password = 'probe-password'
  env.OPENCODE_SERVER_PASSWORD = password
  const port = 20000 + Math.floor(Math.random() * 20000)
  const child = spawn('opencode-safe', ['serve', '--hostname', '127.0.0.1', '--port', String(port)], { env, cwd: project, stdio: 'ignore' })
  const api = `http://127.0.0.1:${port}`
  const auth = { authorization: `Basic ${btoa(`opencode:${password}`)}`, 'content-type': 'application/json' }
  try {
    for (let i = 0; i < 60; i++) {
      if ((await fetch(`${api}/api/info`, { headers: auth }).catch(() => null))?.ok) break
      await Bun.sleep(500)
    }
    for (const [i, leg] of (['anthropic', 'chat', 'responses'] as Leg[]).entries()) {
      const sid = hex(0xfeed00 + i)
      const created = await fetch(`${api}/api/session`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          id: sid,
          title: `agw run-${i}:step-${i}`,
          location: { directory: project },
          model: { providerID: MODELS[leg].provider, id: 'capmodel' },
          metadata: { agw: { runId: `run-${i}`, stepId: `step-${i}`, key: `key-${i}` } },
        }),
      })
      console.log(`[${id}/${leg}] create ${created.status} id=${sid.slice(0, 12)}…`)
      await fetch(`${api}/api/session/${sid}/prompt`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ id: `msg_probe${i}`, text: 'ping' }),
      })
      const want = cap.log.length + 1
      for (let w = 0; w < 80 && cap.log.length < want; w++) await Bun.sleep(250)
      await Bun.sleep(1500) // let the turn finish (title/summary calls would show up as extra requests)
    }
  } finally {
    child.kill('SIGKILL')
  }
  return take(id, since)
}

// ---------- Hermes ----------
const HERMES_DIR = process.env.HERMES_AGENT_DIR ?? join(homedir(), '.hermes/hermes-agent')

async function hermesRun(id: string, transport: 'chat_completions' | 'anthropic_messages', extra: string, runs = 1) {
  const since = cap.log.length
  const home = join(tmp, `hermes-${id}`)
  mkdirSync(home, { recursive: true })
  const base = transport === 'anthropic_messages' ? BASE : `${BASE}/openai/v1`
  writeFileSync(
    join(home, 'config.yaml'),
    [
      'providers:',
      '  capture:',
      `    api: ${base}`,
      '    api_key: dummy-key',
      `    transport: ${transport}`,
      '    default_model: capmodel',
      '    discover_models: false',
      '    models:',
      '      capmodel:',
      '        context_length: 200000',
      extra,
      '',
    ].join('\n'),
  )
  const env: Record<string, string> = {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: join(tmp, `hermes-home-${id}`),
    HERMES_HOME: home,
    PYTHONDONTWRITEBYTECODE: '1',
    TMPDIR: tmp,
    LANG: 'en_US.UTF-8',
    ...deadProxy,
  }
  mkdirSync(env.HOME as string, { recursive: true })
  for (let i = 0; i < runs; i++) {
    const r = await sh(
      [join(HERMES_DIR, 'venv/bin/hermes'), '--ignore-user-config', '-z', 'ping', '--provider', 'capture', '-m', 'capmodel'],
      env,
      home,
      90_000,
    )
    console.log(`[${id}#${i + 1}] exit=${r.code} tail=${JSON.stringify(scrub(r.out.trim()).slice(-200))}`)
  }
  return take(id, since)
}

try {
  if (only !== 'hermes') {
    show('A0 OpenCode baseline (no headers configured), `opencode-safe run --standalone`', await ocRun('A0', ocConfig('plain'), ['anthropic', 'chat', 'responses']))
    show(
      'A1 OpenCode static headers: provider `headers`, `settings.headers`, model `headers`; body overlay',
      await ocRun('A1', ocConfig((['anthropic', 'chat', 'responses'] as Leg[]).map((leg) => ({ leg, headers: true, body: true }))), ['anthropic', 'chat', 'responses']),
    )
    show('A2 OpenCode plugin (`model.request` + `context` hooks), host path: `opencode-safe serve` + HTTP API with session metadata', await ocServe('A2', ocConfig('plain', true)))
  }
  if (only !== 'opencode') {
    show('B0 Hermes baseline (custom provider, nothing configured), chat_completions', await hermesRun('B0', 'chat_completions', ''))
    show(
      'B1 Hermes chat_completions: extra_headers + session_affinity_header (two separate conversations)',
      await hermesRun('B1', 'chat_completions', '    extra_headers:\n      x-agw-caller: hermes\n      x-agw-workflow: static-value\n    session_affinity_header: x-agw-session', 2),
    )
    show(
      'B2 Hermes anthropic_messages: extra_headers + session_affinity_header',
      await hermesRun('B2', 'anthropic_messages', '    extra_headers:\n      x-agw-caller: hermes\n      x-agw-workflow: static-value\n    session_affinity_header: x-agw-session'),
    )
  }
  mkdirSync(evidence, { recursive: true })
  writeFileSync(join(evidence, 'capture.json'), `${scrub(JSON.stringify(results, null, 2))}\n`)
  console.log(`\nraw capture: docs/spikes/gateway/headers/evidence/capture.json (${Object.values(results).flat().length} requests)`)
} finally {
  cap.stop()
  rmSync(tmp, { recursive: true, force: true })
}
