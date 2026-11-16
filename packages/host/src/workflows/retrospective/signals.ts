import { commandRunner, fleetConfig, type RunCommand } from '../../fleet/factory.ts'

/** What the retrospective asks of the factory: file one signal. Throws with the CLI's reason when it cannot. */
export interface SignalPort {
  file(signal: { title: string; text: string }): Promise<void>
}

/** The `--from` of every signal the retrospective files; the repo is the one it proposes changes to. */
export const SIGNAL_SOURCE = 'agent:agent-workflows'
export const SIGNAL_REPO = 'agent-workflows'

const FILE_WALL_MS = 30_000

/**
 * `factory signal file`: triage dedupes signals and makes the Issue (a lead cannot file one itself). Title and text are
 * argv elements, never shell text. Authentication is the factory CLI's own, as for the fleet reads.
 */
export function factorySignals(options: {
  env?: Record<string, string | undefined>
  run?: RunCommand
  bin?: string
}): SignalPort {
  const env = options.env ?? process.env
  const bin = options.bin ?? fleetConfig(env).factoryBin
  const run = options.run ?? commandRunner(env)
  return {
    async file({ title, text }) {
      const result = await run(
        [bin, 'signal', 'file', '--from', SIGNAL_SOURCE, '--repo', SIGNAL_REPO, '--title', title, '--text', text],
        { timeoutMs: FILE_WALL_MS },
      )
      if (result.exitCode === 0) return
      const why = result.timedOut
        ? 'timed out'
        : result.exitCode === null
          ? (result.error ?? 'did not run')
          : `exit ${result.exitCode}: ${result.stderr.trim().slice(0, 300)}`
      throw new Error(`factory signal file failed (${why})`)
    },
  }
}
