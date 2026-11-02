// OpenCode 2.0.32 server plugin: the gateway's attribution headers on every model request, read from `metadata.agw` of
// the step's session. A plain tracked file with no build and no imports: a release is exported from git, and OpenCode
// loads a directory holding this file and its `package.json` (README §Attribution).

/**
 * The `Attribution` field behind each header, as `gatewayHeaders` in `@agent-workflows/capabilities`. No `traceparent`:
 * OpenCode's HTTP client writes its own at send time, after every plugin hook.
 */
const HEADERS = {
  rootId: 'x-agw-session',
  runId: 'x-agw-run-id',
  step: 'x-agw-step',
  workflow: 'x-agw-workflow',
  purpose: 'x-agw-purpose',
  project: 'x-agw-project',
  workspace: 'x-agw-workspace',
  origin: 'x-agw-origin',
  routeFallback: 'x-agw-route-fallback',
}

/** Printable ASCII, 1 to 200 characters, no space at either end: the same filter as `gatewayHeaders`. */
const HEADER_VALUE = /^(?! )[\x20-\x7e]{1,200}(?<! )$/

/** Hops from a child session to its root before the walk gives up (a cycle, a corrupt store). */
const MAX_DEPTH = 32
/** Sessions remembered per plugin instance; the oldest goes first. A session forgotten is only walked again. */
const MAX_REMEMBERED = 4096

export default {
  id: 'agw-attribution',
  setup: async (ctx) => {
    /** Child session to root id. Only the walk is cached: the host rewrites a root's metadata on a follow-up turn. */
    const roots = new Map()

    const remember = (sessionID, rootID) => {
      if (roots.size >= MAX_REMEMBERED) roots.delete(roots.keys().next().value)
      roots.set(sessionID, rootID)
    }

    const rootSession = async (sessionID) => {
      const known = roots.get(sessionID)
      if (known !== undefined) return ctx.session.get({ sessionID: known })
      let session = await ctx.session.get({ sessionID })
      for (let hop = 0; session.parentID; hop++) {
        if (hop === MAX_DEPTH) throw new Error(`no root within ${MAX_DEPTH} parents`)
        session = await ctx.session.get({ sessionID: session.parentID })
      }
      remember(sessionID, session.id)
      return session
    }

    await ctx.session.hook('model.request', async (event) => {
      // Never fails the model call, and never fails quietly: without these headers the request still runs, unattributed.
      try {
        const agw = (await rootSession(event.sessionID)).metadata?.agw
        if (!agw?.runId) throw new Error('root session has no metadata.agw.runId')
        for (const [field, name] of Object.entries(HEADERS)) {
          const value = agw[field]
          if (typeof value === 'string' && HEADER_VALUE.test(value)) event.headers[name] = value
        }
      } catch (error) {
        console.error(`agw-attribution: session ${event.sessionID} sent unattributed: ${error?.message ?? error}`)
      }
    })
  },
}
