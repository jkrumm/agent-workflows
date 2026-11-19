import { spawn } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Env } from '../transports/config.ts'

/**
 * What the owner answered when asked to pass a check agw cannot pass itself. `approved`: the dialog was clicked and the
 * screen share to the mini is open; the check itself is solved afterwards, in the Chrome window, and the read finds out
 * by reading the page again. `why` is a short fixed phrase, never page text.
 */
export type HumanAnswer = { approved: true } | { approved: false; why: string }

/**
 * The opt-in handoff of `web.fetch` (`humanAssist`): one request to the owner, awaited until he answers. `ask` never throws;
 * a cancelled caller gets `{ approved: false, why: 'cancelled' }`.
 */
export interface HumanAssist {
  /** How long the browser read waits for the owner to clear the check once he approved (the tab stays open for it). */
  readonly solveMs: number
  ask(request: { host: string; url: string }, signal: AbortSignal): Promise<HumanAnswer>
}

/** Starts the ask-human script and resolves with its exit code; rejects when it cannot start or `signal` aborts. */
export type Run = (argv: string[], env: Env, signal: AbortSignal) => Promise<number>

const run: Run = (argv, env, signal) =>
  new Promise((resolve, reject) => {
    const [command, ...args] = argv
    const child = spawn(command!, args, { env, stdio: 'ignore', signal })
    child.once('error', reject)
    child.once('close', (code) => resolve(code ?? 1))
  })

const PLAIN_HOST = /^[A-Za-z0-9][A-Za-z0-9.-]*$/
/** The mini's name on the home LAN (Bonjour; the trailing dot makes it an absolute name) and on the tailnet. */
const LAN_SHARE_HOST = 'mini.local.'
const TAILNET_SHARE_HOST = 'mini'
const DEFAULT_SCRIPT = (): string => join(process.env.HOME ?? homedir(), 'SourceRoot/dotfiles/scripts/ask-human.sh')

/**
 * How long the owner has to clear the check once he approved. A person at a screen share, not an agent run: a challenge
 * he has not cleared in this time is reported blocked, as without the flag.
 */
const SOLVE_MS = 10 * 60_000
/** The dialog is shown on the MacBook; the request is written off after this, and the script is stopped with it. */
const DIALOG_MS = 15 * 60_000
const REQUEST_TTL = '30m'

const executable = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** The page as the owner is told about it: origin and path, never the query, the fragment or credentials (a URL can carry secrets). */
function nameOf(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.origin}${parsed.pathname}`
  } catch {
    return 'a page'
  }
}

/** One ping (macOS: one packet, two seconds at most) decides between the LAN name and the fallback; both are plain names. */
const screenShareCommand = (share: string, fallback: string): string =>
  share === fallback
    ? `open vnc://${share}`
    : `if ping -c 1 -t 2 ${share} >/dev/null 2>&1; then open vnc://${share}; else open vnc://${fallback}; fi`

export interface AskHumanOptions {
  env?: Env
  warn?: (message: string) => void
  run?: Run
  /** Whether the script can be run. Default: an executable file exists at the path. */
  exists?: (path: string) => boolean
  solveMs?: number
}

/**
 * The production adapter: `ask-human.sh ask <text> --cmd <screen share command>`, which shows a dialog on the MacBook with
 * that command and runs it only after a click; the script's exit code is the owner's answer (0 clicked, 1 denied, 75 the
 * dialog was not answered, 69 the MacBook was not reachable). The command opens screen share to `AGW_SCREENSHARE_HOST`
 * (default `mini.local.`, the LAN name) after one short ping, and to `AGW_SCREENSHARE_FALLBACK_HOST` (default `mini`, the
 * tailnet name) when the LAN name does not answer. The command is built from validated plain host names only; the text
 * names the page without its query and goes to the script as one argument, never through a shell.
 *
 * `HUMAN_QUEUE_ERRANDS=0`: the request is the dialog alone and no Errand. The factory refuses a bot check as an Errand
 * (Issue 1740: unattended runs must not fill the owner's list); this request exists only because the caller asked for it
 * with `humanAssist`, so the owner is asked once, on screen, and nothing stays open in his list.
 */
export function askHumanAssist(options: AskHumanOptions = {}): HumanAssist {
  const env = options.env ?? process.env
  const warn = options.warn ?? ((message: string) => console.warn(message))
  const start = options.run ?? run
  const exists = options.exists ?? executable
  let off: string | undefined
  return {
    solveMs: options.solveMs ?? SOLVE_MS,
    async ask({ host, url }, signal) {
      if (off) return { approved: false, why: off }
      const script = env.AGW_ASK_HUMAN?.trim() || DEFAULT_SCRIPT()
      const share = env.AGW_SCREENSHARE_HOST?.trim() || LAN_SHARE_HOST
      const fallback = env.AGW_SCREENSHARE_FALLBACK_HOST?.trim() || TAILNET_SHARE_HOST
      if (!exists(script)) {
        off = 'the ask-human script is missing (AGW_ASK_HUMAN)'
        warn(`web.fetch: the owner handoff is off: ${off}`)
        return { approved: false, why: off }
      }
      if (!PLAIN_HOST.test(share) || !PLAIN_HOST.test(fallback)) {
        off = 'AGW_SCREENSHARE_HOST or AGW_SCREENSHARE_FALLBACK_HOST is not a plain host name'
        warn(`web.fetch: the owner handoff is off: ${off}`)
        return { approved: false, why: off }
      }
      const text = `agw: ${nameOf(url)} shows a check only a person can pass. Click Run to open screen share to the mini, then solve it in the Chrome window there; the read goes on by itself once it is cleared.`
      const key = PLAIN_HOST.test(host) ? `agw-human-assist:${host}`.slice(0, 80) : 'agw-human-assist'
      const argv = [
        script,
        'ask',
        text,
        '--cmd',
        screenShareCommand(share, fallback),
        '--key',
        key,
        '--expires',
        REQUEST_TTL,
      ]
      try {
        const code = await start(
          argv,
          { ...env, HUMAN_QUEUE_ERRANDS: '0' },
          AbortSignal.any([signal, AbortSignal.timeout(DIALOG_MS)]),
        )
        if (code === 0) return { approved: true }
        if (code === 1) return { approved: false, why: 'the owner turned the request down' }
        if (code === 75) return { approved: false, why: 'the owner did not answer the request' }
        if (code === 69) return { approved: false, why: 'the owner could not be reached (the MacBook did not answer)' }
        return { approved: false, why: `the request ended with exit ${code}` }
      } catch (error) {
        if (signal.aborted) return { approved: false, why: 'cancelled' }
        if (error instanceof Error && error.name === 'AbortError')
          return { approved: false, why: 'the owner did not answer the request' }
        warn(`web.fetch: the owner handoff failed to start: ${error instanceof Error ? error.message : String(error)}`)
        return { approved: false, why: 'the request could not be started' }
      }
    },
  }
}
