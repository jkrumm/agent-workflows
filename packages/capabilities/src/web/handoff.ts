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
  notify(request: { host: string }): Promise<boolean>
}

const SCREENSHARE_HOST = /^[A-Za-z0-9][A-Za-z0-9.-]*$/
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
 * The production adapter: `ask-human.sh ask <text> --cmd 'open vnc://<screenshare host>'`, which pushes a dialog to the
 * MacBook and runs the command there only after a click. Only the host is named, never the URL (it can carry secrets).
 * A missing script turns the handoff off with one warning, not one per call.
 */
export function askHumanHandoff(options: AskHumanOptions = {}): HumanHandoff {
  const env = options.env ?? process.env
  const warn = options.warn ?? ((message: string) => console.warn(message))
  const start = options.spawn ?? detached
  const exists = options.exists ?? executable
  let off = false
  return {
    async notify({ host }) {
      if (off) return false
      const script = env.AGW_ASK_HUMAN?.trim() || DEFAULT_SCRIPT()
      const share = env.AGW_SCREENSHARE_HOST?.trim() || 'mini'
      if (!exists(script)) {
        off = true
        warn('web.fetch: the owner handoff is off: the ask-human script is missing (AGW_ASK_HUMAN)')
        return false
      }
      if (!SCREENSHARE_HOST.test(share)) {
        off = true
        warn('web.fetch: the owner handoff is off: AGW_SCREENSHARE_HOST is not a plain host name')
        return false
      }
      const text = `agw: ${host} shows a bot check the research Chrome cannot pass. Open screen share to the mini, solve it once in the Chrome window, the cookie stays.`
      try {
        await start([script, 'ask', text, '--cmd', `open vnc://${share}`])
        return true
      } catch (error) {
        warn(`web.fetch: the owner handoff failed to start: ${error instanceof Error ? error.message : String(error)}`)
        return false
      }
    },
  }
}

/** A handoff that records its requests and starts nothing; the default of every test. */
export function fakeHandoff(spawned = true): HumanHandoff & { requests: { host: string }[] } {
  const requests: { host: string }[] = []
  return {
    requests,
    async notify(request) {
      requests.push(request)
      return spawned
    },
  }
}

export const HANDOFF_INTERVAL_MS = 30 * 60_000
const lastAsked = new Map<string, number>()

/** Forget which hosts were asked about (tests). */
export const resetHandoffLimit = (): void => lastAsked.clear()

/** Asks about `host` at most once per 30 minutes; true only when the owner was actually asked. Never throws. */
export async function askOnce(handoff: HumanHandoff, host: string, now = Date.now()): Promise<boolean> {
  const last = lastAsked.get(host)
  if (last !== undefined && now - last < HANDOFF_INTERVAL_MS) return false
  lastAsked.set(host, now)
  try {
    return await handoff.notify({ host })
  } catch {
    return false
  }
}
