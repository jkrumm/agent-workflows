// OpenCode 2.0.32 plugin used by the header probe: sets per-session request headers from inside the
// `model.request` hook, where the session id is in scope, and a body field from the `context` hook.
// `ctx.session.get({ sessionID })` is how the hook reads the metadata the host wrote at session create.
export default {
  id: 'agw-session-headers',
  setup: async (ctx) => {
    await ctx.session.hook('model.request', async (event) => {
      event.headers['x-agw-session'] = event.sessionID
      event.headers['x-agw-kind'] = event.kind
      const session = await ctx.session.get({ sessionID: event.sessionID }).catch(() => undefined)
      const agw = session?.metadata?.agw
      if (agw?.runId) event.headers['x-agw-run-id'] = String(agw.runId)
      if (agw?.stepId) event.headers['x-agw-step'] = String(agw.stepId)
    })
    await ctx.session.hook('context', async (event) => {
      event.options.metadata = { user_id: event.sessionID }
    })
  },
}
