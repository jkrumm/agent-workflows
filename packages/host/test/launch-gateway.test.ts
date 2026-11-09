// scripts/launch-gateway.sh, run by the real zsh from a build directory in a fake HOME. secrets-run is a stand-in over a
// refs table; `bun` is a shim that runs real bun for `-e` (the URL encoding) and dumps the environment for the final
// `exec bun gateway.js`. What is asserted: the template's key wins over a planted iu.env (the Athena team key), the label
// is `personal`, an unresolved or empty ref refuses with 78 naming the ref and never a value, and the composite values are
// built while the raw password/authorization are dropped.
import { afterEach, expect, test } from 'bun:test'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '../../..')
import { describeZsh, ZSH } from '@agent-workflows/testing/zsh'
const TPL = readFileSync(join(ROOT, '.env.gateway.tpl'), 'utf8')

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

// secrets-run over $HOME/refs (`ref<TAB>value`): export / read / run --env-file=F -- cmd.
const SECRETS_RUN = `#!/bin/bash
refs="$HOME/refs"
lookup() { awk -F'\\t' -v r="$1" '$1 == r { print $2; f = 1 } END { exit !f }' "$refs"; }
resolve() { # prints KEY=value lines for the resolvable lines of the template
  while IFS='=' read -r key value; do
    case "$key" in ""|"#"*) continue ;; esac
    case "$value" in
      op://*) v=$(lookup "$value") || continue; printf '%s=%s\\n' "$key" "$v" ;;
      *) printf '%s=%s\\n' "$key" "$value" ;;
    esac
  done < "$tpl"
}
cmd="$1"; shift
case "$cmd" in
  read) lookup "$1" ;;
  export) tpl="\${1#--env-file=}"; resolve | while IFS= read -r l; do printf 'export %s\\n' "$l"; done ;;
  run) tpl="\${1#--env-file=}"; shift 2
       while IFS= read -r l; do export "\${l%%=*}=\${l#*=}"; done < <(resolve)
       exec "$@" ;;
esac
`
const BUN_SHIM = (realBun: string) => `#!/bin/sh
if [ "$1" = "-e" ]; then exec ${realBun} "$@"; fi
env > "$HOME/gateway-env.txt"
echo "$@" > "$HOME/gateway-argv.txt"
`

const REFS: Record<string, string> = {
  'op://common/anthropic/API_KEY': 'personal-key-VALUE',
  'op://common/anthropic/BASE_URL': 'https://iu.example.com',
  'op://mini/agent-workflows/API_SECRET': 'api-secret-VALUE',
  'op://mini/vps-dev/SHARED_USAGE_DB_PASSWORD': 'p@ss/word VALUE',
  'op://mini/agent-workflows/OTEL_EXPORTER_OTLP_ENDPOINT': 'https://otel.example.com',
  'op://vps/argo/HYPERDX_API_KEY_PROD': 'otel-key-VALUE',
}

function run(options: { refs?: Record<string, string>; iuEnv?: string } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'agw-launch-gateway-'))
  dirs.push(home)
  const build = join(home, 'build')
  mkdirSync(build)
  cpSync(join(ROOT, 'scripts', 'launch-gateway.sh'), join(build, 'launch-gateway.sh'))
  writeFileSync(join(build, '.env.gateway.tpl'), TPL)
  writeFileSync(join(build, 'gateway.js'), '')
  const bin = join(home, '.local', 'bin')
  mkdirSync(bin, { recursive: true })
  for (const [name, body] of [
    ['secrets-run', SECRETS_RUN],
    ['bun', BUN_SHIM(process.execPath)],
  ] as const) {
    writeFileSync(join(bin, name), body)
    chmodSync(join(bin, name), 0o755)
  }
  const refs = options.refs ?? REFS
  writeFileSync(
    join(home, 'refs'),
    Object.entries(refs)
      .map(([ref, value]) => `${ref}\t${value}\n`)
      .join(''),
  )
  if (options.iuEnv !== undefined) {
    mkdirSync(join(home, '.config', 'agw'), { recursive: true })
    const file = join(home, '.config', 'agw', 'iu.env')
    writeFileSync(file, options.iuEnv)
    chmodSync(file, 0o600)
  }
  const proc = Bun.spawnSync([ZSH, join(build, 'launch-gateway.sh')], {
    env: { PATH: process.env.PATH ?? '', HOME: home },
  })
  const envFile = join(home, 'gateway-env.txt')
  const env = new Map<string, string>()
  try {
    for (const line of readFileSync(envFile, 'utf8').split('\n')) {
      const at = line.indexOf('=')
      if (at > 0) env.set(line.slice(0, at), line.slice(at + 1))
    }
  } catch {
    // never reached the hand-off
  }
  return { code: proc.exitCode, out: proc.stdout.toString(), err: proc.stderr.toString(), env, build, home }
}

describeZsh('launch-gateway.sh', () => {
  // Every ref must already be in the mini's secrets cache. The IU pair left .env.tpl in Wave 3 (agw holds no provider
  // key) and stays seeded for the gateway alone; any other ref must be one .env.tpl holds.
  const GATEWAY_ONLY_REFS = ['IU_API_KEY=op://common/anthropic/API_KEY', 'IU_BASE_URL=op://common/anthropic/BASE_URL']
  test("the template holds only refs already seeded: .env.tpl's, plus the IU pair", () => {
    const main = readFileSync(join(ROOT, '.env.tpl'), 'utf8')
    for (const line of TPL.split('\n')) {
      if (!line.includes('=op://') || GATEWAY_ONLY_REFS.includes(line)) continue
      expect(main).toContain(line)
    }
  })

  test('hands off to `bun gateway.js` with the template values, IU_KEY_ID=personal and the composites built', () => {
    const r = run()
    expect(r.code).toBe(0)
    expect(readFileSync(join(r.home, 'gateway-argv.txt'), 'utf8').trim()).toBe('gateway.js')
    expect(r.env.get('IU_API_KEY')).toBe('personal-key-VALUE')
    expect(r.env.get('IU_BASE_URL')).toBe('https://iu.example.com')
    expect(r.env.get('IU_KEY_ID')).toBe('personal')
    expect(r.env.get('AGW_API_SECRET')).toBe('api-secret-VALUE')
    expect(r.env.get('USAGE_PG_URL')).toBe(
      `postgres://usage:${encodeURIComponent('p@ss/word VALUE')}@127.0.0.1:5432/shared`,
    )
    expect(r.env.get('OTEL_EXPORTER_OTLP_HEADERS')).toBe('authorization=otel-key-VALUE')
    expect(r.env.get('OTEL_EXPORTER_OTLP_ENDPOINT')).toBe('https://otel.example.com')
    // The raw pieces are dropped; the journal's password was never in this template.
    expect(r.env.has('USAGE_PG_PASSWORD')).toBe(false)
    expect(r.env.has('OTEL_EXPORTER_OTLP_AUTHORIZATION')).toBe(false)
    expect(r.env.has('AGW_PG_PASSWORD')).toBe(false)
    expect(r.env.has('ANTHROPIC_API_KEY')).toBe(false)
    expect(r.out + r.err).not.toContain('VALUE')
  })

  test('a planted iu.env with the Athena team key is never read: the template key and `personal` stand', () => {
    const r = run({ iuEnv: 'IU_API_KEY=athena-team-key-SECRET\nIU_KEY_ID=athena-team\n' })
    expect(r.code).toBe(0)
    expect(r.env.get('IU_API_KEY')).toBe('personal-key-VALUE')
    expect(r.env.get('IU_KEY_ID')).toBe('personal')
    expect([...r.env.values()].some((value) => value.includes('athena-team'))).toBe(false)
    expect(r.err).not.toContain('iu.env')
  })

  test('an unresolved ref refuses with 78, naming the ref and key, never a value', () => {
    const refs = { ...REFS }
    delete refs['op://common/anthropic/API_KEY']
    const r = run({ refs })
    expect(r.code).toBe(78)
    expect(r.err).toContain('refs of .env.gateway.tpl resolved; refusing to start')
    expect(r.err).toContain('unresolved: IU_API_KEY (op://common/anthropic/API_KEY)')
    expect(r.err).not.toContain('VALUE')
    expect(r.env.size).toBe(0)
  })

  test('a ref that resolves to an empty value refuses with 78, naming the key', () => {
    const r = run({ refs: { ...REFS, 'op://mini/agent-workflows/API_SECRET': '' } })
    expect(r.code).toBe(78)
    expect(r.err).toContain('AGW_API_SECRET resolved to an empty value')
    expect(r.err).not.toContain('VALUE')
    expect(r.env.size).toBe(0)
  })

  test('the launcher never mentions the files the gateway must not read', () => {
    const script = readFileSync(join(ROOT, 'scripts', 'launch-gateway.sh'), 'utf8')
    const code = script
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n')
    for (const forbidden of ['iu.env', 'athena-iu']) expect(code).not.toContain(forbidden)
  })
})
