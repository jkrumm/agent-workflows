import { spawn } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Env } from '../transports/config.ts'

/**
 * Asking the owner to pass a bot wall the research Chrome cannot. `notify` resolves `true` once the request was handed
 * off (the dialog itself is never awaited) and `false` when nothing was started; it never throws.
 */
export interface HumanHandoff {
  notify(request: { host: string; pageOpen?: true }): Promise<boolean>
}

const PLAIN_HOST = /^[A-Za-z0-9][A-Za-z0-9.-]*$/
/** The mini's name on the home LAN (Bonjour; the trailing dot makes it an absolute name) and on the tailnet. */
const LAN_SHARE_HOST = 'mini.local.'
const TAILNET_SHARE_HOST = 'mini'
const DEFAULT_SCRIPT = (): string => join(process.env.HOME ?? homedir(), 'SourceRoot/dotfiles/scripts/ask-human.sh')

/** Starts a detached process; resolves once it is running, rejects when it cannot start. */
export type Spawn = (argv: string[]) => Promise<void>

const detached: Spawn = (argv) =>
  new Promise((resolve, reject) => {
    const [command, ...args] = argv
    const child = spawn(command!, args, { detached: true, stdio: 'ignore' })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })

export interface AskHumanOptions {
  env?: Env
  warn?: (message: string) => void
  spawn?: Spawn
  /** Whether the script can be run. Default: an executable file exists at the path. */
  exists?: (path: string) => boolean
}

const executable = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * The production adapter: `ask-human.sh ask <text> --cmd <screen share command>`, which pushes a dialog to the MacBook
 * and runs the command there only after a click. The command opens screen share to `AGW_SCREENSHARE_HOST` (default
 * `mini.local.`, the LAN name: a direct connection) after one short ping, and to `AGW_SCREENSHARE_FALLBACK_HOST`
 * (default `mini`, the tailnet name) when the LAN name does not answer, as off the home network. Only the host of the
 * page is named in the text, never the URL (it can carry secrets), and only a plain host name: a URL host can hold
 * shell metacharacters, so any other host is not named at all; the command is built from validated plain names only.
 * A missing script turns the handoff off with one warning, not one per call.
 */
export function askHumanHandoff(options: AskHumanOptions = {}): HumanHandoff {
  const env = options.env ?? process.env
  const warn = options.warn ?? ((message: string) => console.warn(message))
  const start = options.spawn ?? detached
  const exists = options.exists ?? executable
  let off = false
  return {
    async notify({ host, pageOpen }) {
      if (off) return false
      const script = env.AGW_ASK_HUMAN?.trim() || DEFAULT_SCRIPT()
      const share = env.AGW_SCREENSHARE_HOST?.trim() || LAN_SHARE_HOST
      const fallback = env.AGW_SCREENSHARE_FALLBACK_HOST?.trim() || TAILNET_SHARE_HOST
      if (!exists(script)) {
        off = true
        warn('web.fetch: the owner handoff is off: the ask-human script is missing (AGW_ASK_HUMAN)')
        return false
      }
      if (!PLAIN_HOST.test(share) || !PLAIN_HOST.test(fallback)) {
        off = true
        warn(
          'web.fetch: the owner handoff is off: AGW_SCREENSHARE_HOST or AGW_SCREENSHARE_FALLBACK_HOST is not a plain host name',
        )
        return false
      }
      const site = PLAIN_HOST.test(host) ? host : 'a site'
      const opened = pageOpen ? ' The page is already open in the front Chrome window.' : ''
      const text = `agw: ${site} shows a bot check the research Chrome cannot pass. Open screen share to the mini, solve it once in the Chrome window, the cookie stays.${opened}`
      try {
        await start([script, 'ask', text, '--cmd', screenShareCommand(share, fallback)])
        return true
      } catch (error) {
        warn(`web.fetch: the owner handoff failed to start: ${error instanceof Error ? error.message : String(error)}`)
        return false
      }
    },
  }
}

/** One ping (macOS: one packet, two seconds at most) decides between the LAN name and the fallback; both are plain names. */
const screenShareCommand = (share: string, fallback: string): string =>
  share === fallback
    ? `open vnc://${share}`
    : `if ping -c 1 -t 2 ${share} >/dev/null 2>&1; then open vnc://${share}; else open vnc://${fallback}; fi`

/** A handoff that records its requests and starts nothing; the default of every test. */
export function fakeHandoff(spawned = true): HumanHandoff & { requests: { host: string; pageOpen?: true }[] } {
  const requests: { host: string; pageOpen?: true }[] = []
  return {
    requests,
    async notify(request) {
      requests.push(request)
      return spawned
    },
  }
}

export const HANDOFF_INTERVAL_MS = 30 * 60_000

/**
 * The hosts whose last read ended at a wall (a challenge nobody passed, a bot block), each with its reason, for the
 * handoff interval. A read of such a host is answered from here without a browser or a paid read: the wall is still
 * up, and the 20 s settle plus a Tavily call that fails too is what every repeat would otherwise cost. A read that
 * passes clears it.
 */
export class WallMemory<R extends string = string> {
  private readonly walls = new Map<string, { reason: R; at: number }>()

  remember(host: string, reason: R, now = Date.now()): void {
    for (const [other, wall] of this.walls) if (now - wall.at >= HANDOFF_INTERVAL_MS) this.walls.delete(other)
    this.walls.set(host, { reason, at: now })
  }

  /** The wall still standing at `host`: its reason and when it was met; undefined once the interval is over. */
  recall(host: string, now = Date.now()): { reason: R; at: number } | undefined {
    const wall = this.walls.get(host)
    if (!wall) return undefined
    if (now - wall.at < HANDOFF_INTERVAL_MS) return wall
    this.walls.delete(host)
    return undefined
  }

  clear(host: string): void {
    this.walls.delete(host)
  }
}

const lastAsked = new Map<string, number>()

/** Forget which hosts were asked about (tests). */
export const resetHandoffLimit = (): void => lastAsked.clear()

/** The challenged page, put on screen for the owner: `open` resolves `true` when it is there, `close` takes it away again. */
export interface OwnerPage {
  open(): Promise<boolean>
  close(): Promise<void>
}

/**
 * Asks about `host` at most once per 30 minutes; true only when the owner was actually asked. Never throws.
 * `page` is opened only when the owner is to be asked, before the dialog (which then says the page is open), and
 * closed again when the dialog could not be started.
 */
export async function askOnce(
  handoff: HumanHandoff,
  host: string,
  now = Date.now(),
  page?: OwnerPage,
): Promise<boolean> {
  const last = lastAsked.get(host)
  if (last !== undefined && now - last < HANDOFF_INTERVAL_MS) return false
  lastAsked.set(host, now)
  const pageOpen = (await page?.open().catch(() => false)) === true
  let asked = false
  try {
    asked = await handoff.notify({ host, ...(pageOpen ? { pageOpen: true as const } : {}) })
  } catch {
    asked = false
  }
  if (!asked && pageOpen) await page?.close().catch(() => undefined)
  return asked
}
