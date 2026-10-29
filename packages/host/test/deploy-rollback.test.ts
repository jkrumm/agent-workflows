// scripts/deploy.sh's rollback, run by the real zsh with launchd and health stubbed: which LaunchAgent plists stay on
// disk after a failed deploy. A plist this deploy rendered for a failed sha goes when its process is left down; a
// redeploy of the live sha keeps its plists; a plist this deploy never wrote is never removed.
import { afterEach, describe, expect, test } from 'bun:test'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '../../..')
const ZSH = Bun.which('zsh')
const NEW = 'a'.repeat(40)
const PREV = 'b'.repeat(40)
const HOST = 'com.jkrumm.agent-workflows-host'
const AUDIO = 'com.jkrumm.agent-workflows-audio'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A fake HOME with releases NEW (both templates) and PREV (`prevHas`), and the deploy functions sourced. */
function setup(prevHas: string[]) {
  const home = mkdtempSync(join(tmpdir(), 'agw-rollback-'))
  dirs.push(home)
  const releases = join(home, '.agent-workflows', 'releases')
  for (const [sha, labels] of [
    [NEW, [HOST, AUDIO]],
    [PREV, prevHas],
  ] as const) {
    mkdirSync(join(releases, sha, 'deploy'), { recursive: true })
    for (const label of labels) {
      cpSync(join(ROOT, 'deploy', `${label}.plist.template`), join(releases, sha, 'deploy', `${label}.plist.template`))
    }
  }
  mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true })
  const plist = (label: string) => join(home, 'Library', 'LaunchAgents', `${label}.plist`)
  /** Runs `body` after sourcing every function of deploy.sh (not `main`), with launchd, logs and health stubbed. */
  const run = (body: string) => {
    if (!ZSH) throw new Error('zsh is not on PATH: scripts/deploy.sh needs it (CI installs it in ci.yml)')
    const fns = readFileSync(join(ROOT, 'scripts', 'deploy.sh'), 'utf8').replace(/\nmain\s*$/, '\n')
    const script = `${fns}
launchctl() { return 0 }
plutil() { return 0 }
loaded() { return 1 }
stop_all() { return 0 }
tail_logs() { :; }
wait_healthy() { return 0 }
mark_deliberate_restart() { :; }
${body}`
    const proc = Bun.spawnSync([ZSH, '-c', script], { env: { PATH: process.env.PATH ?? '', HOME: home } })
    if (proc.exitCode !== 0) throw new Error(`zsh exited ${proc.exitCode}: ${proc.stderr.toString()}`)
    return proc.stderr.toString()
  }
  const renderedFor = (label: string) => (existsSync(plist(label)) ? readFileSync(plist(label), 'utf8') : null)
  return { run, plist, renderedFor, releases }
}

const startNew = 'for p in $PROCESSES; do start_process "$p" "$RELEASES/' + NEW + '" ' + NEW + '; done'

describe('deploy.sh rollback plists', () => {
  test('a previous release without the audio process: audio plist removed, host re-rendered for it', () => {
    const t = setup([HOST])
    const out = t.run(`${startNew}\nroll_back ${NEW} ${PREV} 1 ${PREV}`)
    expect(t.renderedFor(AUDIO)).toBeNull()
    expect(t.renderedFor(HOST)).toContain(PREV)
    expect(out).toContain(`removed ${t.plist(AUDIO)}`)
  })

  test('a first deploy that fails removes the plists it rendered', () => {
    const t = setup([])
    t.run(`${startNew}\nroll_back ${NEW} "" 1 ""`)
    expect(t.renderedFor(HOST)).toBeNull()
    expect(t.renderedFor(AUDIO)).toBeNull()
  })

  test('a redeploy of the live sha that fails keeps every plist for the next login', () => {
    const t = setup([])
    const out = t.run(`${startNew}\nroll_back ${NEW} "" 1 ${NEW}`)
    expect(t.renderedFor(HOST)).toContain(NEW)
    expect(t.renderedFor(AUDIO)).toContain(NEW)
    expect(out).toContain('plists kept')
  })

  test('a plist this deploy never rendered is never removed', () => {
    const t = setup([HOST])
    writeFileSync(t.plist(AUDIO), 'an older deploy wrote this')
    // The host's bootstrap failed first: the audio plist was never rendered by this deploy.
    t.run(`start_process host "$RELEASES/${NEW}" ${NEW}\nroll_back ${NEW} ${PREV} 1 ${PREV}`)
    expect(t.renderedFor(AUDIO)).toBe('an older deploy wrote this')
  })
})
