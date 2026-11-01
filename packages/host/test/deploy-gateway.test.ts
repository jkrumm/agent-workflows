// scripts/deploy.sh's gateway: the real script, run by the real zsh in a fake HOME with launchctl, curl, plutil and
// secrets-run replaced by stand-ins. The stand-in launchd keeps the loaded plists; the stand-in curl answers /health from
// the loaded plist's AGW_VERSION / AGW_GATEWAY_BUILD unless a process is marked unhealthy. What is asserted: a build
// that did not change leaves the gateway running, a changed one restarts and is awaited on `build`, a failed deploy
// that restarted it puts the previous build's directory back, a failure that did not touch it leaves it alone, and the
// build directories are immutable, deterministic and pruned without ever losing the live or the previous one.
import { afterEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '../../..')
const ZSH = Bun.which('zsh')
const NEW = 'a'.repeat(40)
const PREV = 'b'.repeat(40)
const HOST = 'com.jkrumm.agent-workflows-host'
const AUDIO = 'com.jkrumm.agent-workflows-audio'
const GATEWAY = 'com.jkrumm.agent-workflows-gateway'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

// A stateful stand-in launchd: bootstrap loads a plist (a copy is kept), bootout unloads, print answers by state.
const FAKE_LAUNCHCTL = `#!/bin/sh
echo "$*" >> "$HOME/launchctl.log"
state="$HOME/launchd"
mkdir -p "$state"
case "$1" in
  bootstrap) label=$(basename "$3" .plist); cp "$3" "$state/$label.plist" ;;
  bootout) rm -f "$state/$(basename "$2").plist" ;;
  print) [ -f "$state/$(basename "$2").plist" ] ;;
esac
`
// /health from the loaded plist: version = AGW_VERSION, build = AGW_GATEWAY_BUILD. A port with a file in $HOME/down is
// unreachable; the gateway also fails when its build is the one named in $HOME/bad-build.
const FAKE_CURL = `#!/bin/sh
url=""
for arg in "$@"; do url="$arg"; done
port=$(echo "$url" | sed -n 's|.*127.0.0.1:\\([0-9]*\\)/health|\\1|p')
[ -n "$port" ] || exit 22
case "$port" in 7791) label=${HOST} ;; 7792) label=${AUDIO} ;; 7793) label=${GATEWAY} ;; *) exit 22 ;; esac
plist="$HOME/launchd/$label.plist"
[ -f "$plist" ] || exit 7
[ ! -f "$HOME/down/$port" ] || exit 22
val() { awk -v k="$1" '$0 ~ "<key>" k "</key>" { getline; gsub(/<[^>]*>|[ \\t]/, ""); print }' "$plist"; }
build=$(val AGW_GATEWAY_BUILD)
if [ "$port" = 7793 ]; then
  [ -f "$HOME/bad-build" ] && [ "$build" = "$(cat "$HOME/bad-build")" ] && exit 22
  printf '{"status":"ok","version":"%s","build":"%s"}' "$(val AGW_VERSION)" "$build"
else
  printf '{"status":"ok","version":"%s"}' "$(val AGW_VERSION)"
fi
`

type Setup = ReturnType<typeof setup>

/** A fake HOME with releases, the stand-ins on its PATH and a runner for the real deploy.sh at one sha. */
function setup() {
  const home = mkdtempSync(join(tmpdir(), 'agw-deploy-gateway-'))
  dirs.push(home)
  const bin = join(home, '.local', 'bin')
  mkdirSync(bin, { recursive: true })
  const stub = (name: string, body: string) => {
    writeFileSync(join(bin, name), body)
    chmodSync(join(bin, name), 0o755)
  }
  stub('launchctl', FAKE_LAUNCHCTL)
  stub('curl', FAKE_CURL)
  stub('plutil', '#!/bin/sh\n[ "$1" = "-extract" ] && echo 120\nexit 0\n')
  stub('secrets-run', '#!/bin/sh\necho test-secret\n')
  const aw = join(home, '.agent-workflows')
  const release = (sha: string, gatewayMarker: string) => {
    const dir = join(aw, 'releases', sha)
    mkdirSync(join(dir, 'deploy'), { recursive: true })
    for (const label of [HOST, AUDIO, GATEWAY]) {
      cpSync(join(ROOT, 'deploy', `${label}.plist.template`), join(dir, 'deploy', `${label}.plist.template`))
    }
    mkdirSync(join(dir, 'scripts'), { recursive: true })
    cpSync(join(ROOT, 'scripts', 'launch-gateway.sh'), join(dir, 'scripts', 'launch-gateway.sh'))
    cpSync(join(ROOT, '.env.gateway.tpl'), join(dir, '.env.gateway.tpl'))
    mkdirSync(join(dir, 'packages', 'host', 'src'), { recursive: true })
    for (const file of ['door-tokens.ts', 'auth.ts']) {
      cpSync(join(ROOT, 'packages', 'host', 'src', file), join(dir, 'packages', 'host', 'src', file))
    }
    mkdirSync(join(dir, 'packages', 'gateway', 'src'), { recursive: true })
    writeFileSync(join(dir, 'packages', 'gateway', 'src', 'main.ts'), `console.log(${JSON.stringify(gatewayMarker)})\n`)
    writeFileSync(join(dir, '.complete'), '')
    return dir
  }
  const plist = (label: string) => join(home, 'Library', 'LaunchAgents', `${label}.plist`)
  const launchctlLog = () =>
    existsSync(join(home, 'launchctl.log')) ? readFileSync(join(home, 'launchctl.log'), 'utf8') : ''
  const loadedPlist = (label: string) => {
    const file = join(home, 'launchd', `${label}.plist`)
    return existsSync(file) ? readFileSync(file, 'utf8') : null
  }
  const data = (name: string) => {
    const file = join(aw, 'data', name)
    return existsSync(file) ? readFileSync(file, 'utf8').trim() : null
  }
  const markDown = (port: number) => {
    mkdirSync(join(home, 'down'), { recursive: true })
    writeFileSync(join(home, 'down', String(port)), '')
  }
  /** Runs the real deploy.sh as release `sha` (the re-exec already done), returning its exit code and output. */
  const deploy = (sha: string) => {
    if (!ZSH) throw new Error('zsh is not on PATH: scripts/deploy.sh needs it (CI installs it in ci.yml)')
    const proc = Bun.spawnSync([ZSH, join(ROOT, 'scripts', 'deploy.sh')], {
      env: {
        PATH: process.env.PATH ?? '',
        HOME: home,
        AGW_DEPLOY_SHA: sha,
        AGW_DEPLOY_REEXEC: '1',
        HEALTH_WAIT_SECS: '3',
      },
    })
    return { code: proc.exitCode, out: proc.stdout.toString(), err: proc.stderr.toString() }
  }
  return { home, aw, release, plist, launchctlLog, loadedPlist, data, markDown, deploy, stub }
}

/** A first deploy of PREV (gateway marker `old`), then NEW is exported with `fresh`: ready to deploy NEW. */
function liveThenNew(old: string, fresh: string): Setup & { oldBuild: string } {
  const t = setup()
  t.release(PREV, old)
  const first = t.deploy(PREV)
  expect(first.code).toBe(0)
  const oldBuild = t.data('gateway-build') as string
  expect(oldBuild).toMatch(/^[0-9a-f]{16}$/)
  t.release(NEW, fresh)
  writeFileSync(join(t.home, 'launchctl.log'), '')
  return { ...t, oldBuild }
}

const touches = (log: string, label: string, verb: string) =>
  log.split('\n').filter((line) => line.startsWith(`${verb} `) && line.includes(label)).length

describe('deploy.sh gateway: the restart rule', () => {
  test('the first deploy builds, installs and starts the gateway beside host and audio', () => {
    const t = setup()
    t.release(PREV, 'v1')
    const result = t.deploy(PREV)
    expect(result.code).toBe(0)
    const build = t.data('gateway-build') as string
    const dir = join(t.aw, 'gateway', build)
    for (const file of ['gateway.js', 'launch-gateway.sh', '.env.gateway.tpl', 'plist.template', '.complete']) {
      expect(existsSync(join(dir, file))).toBe(true)
    }
    const rendered = readFileSync(t.plist(GATEWAY), 'utf8')
    expect(rendered).not.toMatch(/__[A-Z_]+__/)
    expect(rendered).toContain(`${dir}/launch-gateway.sh`)
    expect(rendered).not.toContain(join(t.aw, 'releases'))
    for (const expected of [
      '<key>AGW_GATEWAY_PORT</key>\n    <string>7793</string>',
      `<key>AGW_GATEWAY_BUILD</key>\n    <string>${build}</string>`,
      `<key>AGW_VERSION</key>\n    <string>${PREV}</string>`,
      `<string>${join(t.aw, 'data', 'door-tokens')}</string>`,
      `<string>${join(t.aw, 'data', 'gateway')}</string>`,
      `<string>${t.home}/SourceRoot/dotfiles/config/claude-accounts.json</string>`,
      '<key>ExitTimeOut</key>\n  <integer>90</integer>',
    ]) {
      expect(rendered).toContain(expected)
    }
    expect(t.data('gateway-previous-build')).toBeNull()
    expect(result.out).toContain('gateway build')
    // The CLI's process list stays host-relative: the gateway serves no capability.
    expect(readFileSync(join(t.home, '.config', 'agw', 'env'), 'utf8')).toContain(
      'AGW_PROCESSES=audio=http://127.0.0.1:7792\n',
    )
    expect(readFileSync(join(t.home, '.config', 'agw', 'env'), 'utf8')).not.toContain('7793')
  })

  test('an unchanged build, loaded and healthy: the gateway is never booted out, host and audio restart', () => {
    const t = liveThenNew('v1', 'v1')
    const result = t.deploy(NEW)
    expect(result.code).toBe(0)
    expect(result.out).toContain(`gateway unchanged (build ${t.oldBuild}), not restarted`)
    const log = t.launchctlLog()
    expect(touches(log, GATEWAY, 'bootout')).toBe(0)
    expect(touches(log, GATEWAY, 'bootstrap')).toBe(0)
    expect(touches(log, HOST, 'bootout')).toBe(1)
    expect(touches(log, HOST, 'bootstrap')).toBe(1)
    expect(touches(log, AUDIO, 'bootstrap')).toBe(1)
    expect(t.data('gateway-build')).toBe(t.oldBuild)
    expect(t.data('deployed-sha')).toBe(NEW)
    // Still the plist of the first deploy: it points at the build directory, which no release prune can remove.
    expect(t.loadedPlist(GATEWAY)).toContain(`<string>${PREV}</string>`)
  })

  test('a changed build is stopped, started and awaited on its build; the old build becomes the previous one', () => {
    const t = liveThenNew('v1', 'v2')
    const result = t.deploy(NEW)
    expect(result.code).toBe(0)
    const build = t.data('gateway-build') as string
    expect(build).not.toBe(t.oldBuild)
    expect(t.data('gateway-previous-build')).toBe(t.oldBuild)
    const log = t.launchctlLog()
    expect(touches(log, GATEWAY, 'bootout')).toBe(1)
    expect(touches(log, GATEWAY, 'bootstrap')).toBe(1)
    expect(t.loadedPlist(GATEWAY)).toContain(`<string>${build}</string>`)
    expect(t.loadedPlist(GATEWAY)).toContain(join(t.aw, 'gateway', build))
    expect(existsSync(join(t.aw, 'gateway', t.oldBuild, '.complete'))).toBe(true)
    expect(result.out).not.toContain('gateway unchanged')
  })

  test('the same build but not loaded, or not healthy, is restarted', () => {
    const notLoaded = liveThenNew('v1', 'v1')
    rmSync(join(notLoaded.home, 'launchd', `${GATEWAY}.plist`))
    expect(notLoaded.deploy(NEW).code).toBe(0)
    expect(touches(notLoaded.launchctlLog(), GATEWAY, 'bootstrap')).toBe(1)

    const unhealthy = liveThenNew('v1', 'v1')
    unhealthy.markDown(7793)
    // The gateway never answers, so the deploy fails: what matters is that it was restarted rather than trusted.
    const result = unhealthy.deploy(NEW)
    expect(touches(unhealthy.launchctlLog(), GATEWAY, 'bootout')).toBeGreaterThanOrEqual(1)
    expect(result.code).toBe(1)
  }, 60_000)
})

describe('deploy.sh gateway: rollback', () => {
  test('a gateway that never becomes healthy rolls all three back; the gateway boots the previous build directory', () => {
    const t = liveThenNew('v1', 'v2')
    // Whatever build the new gateway has is bad: find it by deploying the same source into a scratch home first.
    const probe = setup()
    probe.release(NEW, 'v2')
    probe.deploy(NEW)
    writeFileSync(join(t.home, 'bad-build'), probe.data('gateway-build') as string)

    const result = t.deploy(NEW)
    expect(result.code).toBe(1)
    expect(result.err).toContain('rolling back to')
    expect(result.err).toContain(`gateway back to build ${t.oldBuild}`)
    expect(result.err).toContain('rollback OK')
    // Everything is back: the previous release's host and audio, the previous build's gateway.
    expect(t.loadedPlist(HOST)).toContain(`<string>${PREV}</string>`)
    expect(t.loadedPlist(AUDIO)).toContain(`<string>${PREV}</string>`)
    expect(t.loadedPlist(GATEWAY)).toContain(join(t.aw, 'gateway', t.oldBuild))
    expect(t.loadedPlist(GATEWAY)).toContain(`<key>AGW_GATEWAY_BUILD</key>\n    <string>${t.oldBuild}</string>`)
    expect(t.data('gateway-build')).toBe(t.oldBuild)
    expect(t.data('deployed-sha')).toBe(PREV)
  }, 60_000)

  test('a host failure on a deploy that left the gateway running does not touch the gateway', () => {
    const t = liveThenNew('v1', 'v1')
    const sha = NEW
    // The new host never answers; the audio process and the unchanged gateway are fine. The rollback is the host's.
    t.stub(
      'curl',
      `#!/bin/sh\nfor a in "$@"; do url="$a"; done\nif echo "$url" | grep -q ':7791/'; then grep -q '<string>${sha}</string>' "$HOME/launchd/${HOST}.plist" 2>/dev/null && exit 22; fi\nexec ${join(t.home, '.local', 'bin', 'curl.real')} "$@"\n`,
    )
    writeFileSync(join(t.home, '.local', 'bin', 'curl.real'), FAKE_CURL)
    chmodSync(join(t.home, '.local', 'bin', 'curl.real'), 0o755)
    const result = t.deploy(sha)
    expect(result.code).toBe(1)
    expect(result.out).toContain(`gateway unchanged (build ${t.oldBuild}), not restarted`)
    const log = t.launchctlLog()
    expect(touches(log, GATEWAY, 'bootout')).toBe(0)
    expect(touches(log, GATEWAY, 'bootstrap')).toBe(0)
    expect(result.err).toContain('rolling back to')
    expect(t.loadedPlist(HOST)).toContain(`<string>${PREV}</string>`)
    expect(t.loadedPlist(GATEWAY)).not.toBeNull()
    expect(t.data('gateway-build')).toBe(t.oldBuild)
  }, 60_000)

  test('a first gateway that never becomes healthy has its plist removed, and host and audio roll back', () => {
    // PREV is live from before the gateway existed: only its deployed-sha is recorded, no gateway build.
    const u = setup()
    u.release(PREV, 'v1')
    mkdirSync(join(u.aw, 'data'), { recursive: true })
    writeFileSync(join(u.aw, 'data', 'deployed-sha'), PREV)
    u.release(NEW, 'v1')
    u.markDown(7793)
    const result = u.deploy(NEW)
    expect(result.code).toBe(1)
    expect(result.err).toContain('no previous gateway build')
    expect(existsSync(u.plist(GATEWAY))).toBe(false)
    expect(u.loadedPlist(GATEWAY)).toBeNull()
    expect(u.loadedPlist(HOST)).toContain(`<string>${PREV}</string>`)
    expect(u.data('gateway-build')).toBeNull()
  }, 60_000)
})

/** Runs build_gateway / prune_gateway_builds from the real script, with the stand-ins on PATH. */
function functions(t: Setup, body: string) {
  if (!ZSH) throw new Error('zsh is not on PATH')
  const fns = readFileSync(join(ROOT, 'scripts', 'deploy.sh'), 'utf8').replace(/\nmain\s*$/, '\n')
  const proc = Bun.spawnSync([ZSH, '-c', `${fns}\n${body}`], { env: { PATH: process.env.PATH ?? '', HOME: t.home } })
  return { code: proc.exitCode, out: proc.stdout.toString(), err: proc.stderr.toString() }
}

describe('deploy.sh gateway: the build directory', () => {
  test('the bundle is deterministic: two builds of one release, and of the same source in another release path', () => {
    const t = setup()
    const a = t.release('1'.repeat(40), 'same')
    const b = t.release('2'.repeat(40), 'same')
    const bundle = (release: string) => {
      const out = join(t.home, `out-${Math.random().toString(36).slice(2)}.js`)
      const proc = Bun.spawnSync(['bun', 'build', '--target=bun', '--outfile', out, 'packages/gateway/src/main.ts'], {
        cwd: release,
      })
      expect(proc.exitCode).toBe(0)
      return readFileSync(out)
    }
    expect(bundle(a).equals(bundle(a))).toBe(true)
    expect(bundle(a).equals(bundle(b))).toBe(true)
    // And the id the script derives is the same for both releases.
    const idOf = (release: string) => functions(t, `build_gateway ${release}; print -r -- $GW_BUILD`).out.trim()
    expect(idOf(a)).toMatch(/^[0-9a-f]{16}$/)
    expect(idOf(a)).toBe(idOf(b))
  })

  test('the id changes with each input: bundle, launcher, env template, plist template', () => {
    const t = setup()
    const base = t.release('1'.repeat(40), 'one')
    const idOf = (release: string) => functions(t, `build_gateway ${release}; print -r -- $GW_BUILD`).out.trim()
    const baseId = idOf(base)
    const variants: Array<[string, string]> = [
      ['packages/gateway/src/main.ts', 'console.log("two")\n'],
      ['scripts/launch-gateway.sh', '# changed\n'],
      ['.env.gateway.tpl', '# changed\n'],
      [`deploy/${GATEWAY}.plist.template`, '<!-- changed -->\n'],
    ]
    const seen = new Set([baseId])
    variants.forEach(([file, extra], index) => {
      const sha = String(index + 3).repeat(40)
      const release = t.release(sha, 'one')
      const path = join(release, file)
      writeFileSync(path, file.endsWith('main.ts') ? extra : readFileSync(path, 'utf8') + extra)
      const id = idOf(release)
      expect(id).toMatch(/^[0-9a-f]{16}$/)
      seen.add(id)
    })
    expect(seen.size).toBe(5)
  })

  test('a complete build is immutable; an incomplete one is rebuilt', () => {
    const t = setup()
    const release = t.release('1'.repeat(40), 'one')
    const id = functions(t, `build_gateway ${release}; print -r -- $GW_BUILD`).out.trim()
    const dir = join(t.aw, 'gateway', id)
    writeFileSync(join(dir, 'marker'), 'kept')
    functions(t, `build_gateway ${release}`)
    expect(readFileSync(join(dir, 'marker'), 'utf8')).toBe('kept')

    rmSync(join(dir, '.complete'))
    functions(t, `build_gateway ${release}`)
    expect(existsSync(join(dir, 'marker'))).toBe(false)
    expect(existsSync(join(dir, '.complete'))).toBe(true)
    expect(existsSync(join(dir, 'gateway.js'))).toBe(true)
  })

  test('a release without the gateway entry is refused before anything is stopped', () => {
    const t = setup()
    const release = t.release('1'.repeat(40), 'one')
    rmSync(join(release, 'packages', 'gateway'), { recursive: true })
    const result = functions(t, `build_gateway ${release}`)
    expect(result.code).toBe(1)
    expect(result.err).toContain('this release has no gateway')
  })

  test('prune keeps the newest three builds plus the live and the previous one, and nothing else', () => {
    const t = setup()
    const root = join(t.aw, 'gateway')
    const names = Array.from({ length: 7 }, (_, i) => `${String(i)}`.repeat(16))
    // names[0] is the oldest. The live build is the second oldest, the previous the oldest: both are older than the newest 3.
    names.forEach((name, i) => {
      mkdirSync(join(root, name), { recursive: true })
      writeFileSync(join(root, name, '.complete'), '')
      const when = new Date(Date.now() - (names.length - i) * 3600_000)
      utimesSync(join(root, name), when, when)
    })
    mkdirSync(join(root, '9'.repeat(16)), { recursive: true }) // incomplete: left alone
    mkdirSync(join(root, 'notabuild'), { recursive: true }) // not a build id: left alone
    const live = names[1] as string
    const previous = names[0] as string
    const result = functions(t, `prune_gateway_builds ${live} ${previous}`)
    expect(result.code).toBe(0)
    const left = readdirSync(root).sort()
    expect(left).toEqual([...names.slice(4), live, previous, '9'.repeat(16), 'notabuild'].sort())
  })

  test('prune with nothing recorded removes only what is older than the newest three', () => {
    const t = setup()
    const root = join(t.aw, 'gateway')
    for (let i = 0; i < 5; i++) {
      const name = String(i).repeat(16)
      mkdirSync(join(root, name), { recursive: true })
      writeFileSync(join(root, name, '.complete'), '')
      const when = new Date(Date.now() - (5 - i) * 3600_000)
      utimesSync(join(root, name), when, when)
    }
    expect(functions(t, `prune_gateway_builds "" ""`).code).toBe(0)
    expect(readdirSync(root).sort()).toEqual(['2'.repeat(16), '3'.repeat(16), '4'.repeat(16)])
  })
})
