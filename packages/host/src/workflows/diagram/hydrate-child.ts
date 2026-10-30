import { dirname, join } from 'node:path'
import { installDomShim } from './dom-shim.ts'
import { startWatchdog } from './watchdog.ts'

/**
 * The hydration child (`hydrate.ts` starts one per call, `bun hydrate-child.ts`): reads `{ skeleton }` from stdin,
 * installs the DOM shim on its own global scope, imports the pinned `@excalidraw/excalidraw` and writes one JSON reply
 * to stdout: `{ ok: true, document }` (the library's `serializeAsJSON` string) or `{ ok: false, error }`.
 *
 * Only a conversion error is a reply with `ok: false`: it is the agent's skeleton, and the host re-asks. Everything else
 * (unreadable input, the package not resolving, the shim, the fonts, the canvas) is the host's: the child writes the
 * error to stderr and exits non-zero, which the host reports as an infra error and never takes to the agent.
 */
const APP_STATE = { gridSize: null, viewBackgroundColor: '#ffffff' }
const DEADLINE_ENV = 'AGW_HYDRATE_DEADLINE_MS'

type Convert = (skeleton: unknown[]) => string

async function load(): Promise<Convert> {
  const entry = Bun.resolveSync('@excalidraw/excalidraw', import.meta.dir)
  installDomShim(join(dirname(entry), 'fonts'))
  const { convertToExcalidrawElements, serializeAsJSON } = await import('@excalidraw/excalidraw')
  return (skeleton) => {
    // oxlint-disable-next-line typescript/no-explicit-any -- the library types its skeleton as a union of element types
    const elements = convertToExcalidrawElements(skeleton as any, { regenerateIds: false })
    // oxlint-disable-next-line typescript/no-explicit-any -- appState is a partial of the library's AppState
    return serializeAsJSON(elements, APP_STATE as any, {}, 'local')
  }
}

const deadlineMs = Number(process.env[DEADLINE_ENV])
if (Number.isFinite(deadlineMs) && deadlineMs > 0)
  startWatchdog({ deadlineMs, parentPid: () => process.ppid, exit: (code) => process.exit(code) })

let convert: Convert
let skeleton: unknown[]
try {
  skeleton = (JSON.parse(await Bun.stdin.text()) as { skeleton: unknown[] }).skeleton
  convert = await load()
} catch (error) {
  console.error(`hydration setup failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
  process.exit(1)
}
let reply: { ok: true; document: string } | { ok: false; error: string }
try {
  reply = { ok: true, document: convert(skeleton) }
} catch (error) {
  reply = { ok: false, error: error instanceof Error ? error.message : String(error) }
}
await Bun.write(Bun.stdout, JSON.stringify(reply))
process.exit(0)
