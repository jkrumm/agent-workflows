import type { AgentHost } from '@agent-workflows/runtime'

export const AGENT_HOST_UNWIRED = 'agent host not wired'

/** Fails every agent step with a clear error until the OpenCode adapter is wired into `main.ts`. */
export const unwiredAgentHost: AgentHost = {
  async open() {
    throw new Error(AGENT_HOST_UNWIRED)
  },
  async prompt() {
    throw new Error(AGENT_HOST_UNWIRED)
  },
  async wait() {
    throw new Error(AGENT_HOST_UNWIRED)
  },
  async steer() {
    throw new Error(AGENT_HOST_UNWIRED)
  },
  async abort() {
    // Idempotent and harmless: there is no session to abort.
  },
}
