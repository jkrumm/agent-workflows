import { DEFAULT_AGENT_IDLE_MS } from '@agent-workflows/runtime'

/** The margin above the largest step window: the tool-use turn that launches a step and the one that reports it. */
const SESSION_MARGIN_S = 120

/**
 * The agent step's idle window. A shell call writes nothing to the session while it runs, so the host's idle timer
 * must outlast the largest step window the agent was told about, or it kills the session first. Never below the
 * runtime's default.
 */
export function agentIdleMs(stepSeconds: number, testSeconds: number): number {
  return Math.max(DEFAULT_AGENT_IDLE_MS, (Math.max(stepSeconds, testSeconds) + SESSION_MARGIN_S) * 1000)
}

/** Appended to the prompt of the one retry after a reply that was not the schema's JSON. */
export const JSON_ONLY_RETRY = `

RETRY: your previous reply was rejected because it was not valid JSON matching the schema.
Reply with ONLY the JSON object from the Output section: one object, optionally in a single \`\`\`json fence, with
no text before or after it. \`name\` must be one of format, lint, typecheck, test, fallow, check. Do not run any command
again unless you never ran it; emit the JSON as your final message and stop.`

/**
 * The per-run request. The stable rules are the agent's `AGENTS.md` (the cacheable prefix); this carries only what
 * differs per run, so the session's first tokens are the same for every run of the agent.
 */
export function agentPrompt(options: { cwd: string; commands?: string[]; idleMs: number }): string {
  const { cwd, commands, idleMs } = options
  const mode =
    commands && commands.length > 0
      ? `Mode: COMMANDS. Run exactly these, in order:\n${commands.map((command, i) => `${i + 1}. \`${command}\``).join('\n')}`
      : 'Mode: DISCOVER.'
  return [
    `Working directory: ${cwd}`,
    `Idle window: the host kills the session after ${Math.round(idleMs / 1000)}s without any output.`,
    mode,
  ].join('\n')
}
