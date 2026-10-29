import { homedir } from 'node:os'
import { join } from 'node:path'
import { assertNoProblems, type Env, type ProcessConfig, readProcessConfig } from '@agent-workflows/host'

export const AUDIO_PORT = 7792
/** The door-only listener: the door's routes and nothing else, for callers off the mini (`tailscale serve` points here). */
export const AUDIO_DOOR_PORT = 7793

/** The audio process: the shared process settings on its own port, its own state dir and the door's caller tokens. */
export interface AudioProcessConfig extends ProcessConfig {
  /**
   * The tool gate's and the (lazy) agent host's state dir (`AGW_AUDIO_STATE_DIR`). Never the host's: two tool gates
   * sharing one `gate.json` would overwrite each other's address and key.
   */
  stateDir: string
  /** The door-only loopback listener (`AGW_AUDIO_DOOR_PORT`): the door's routes, a 404 for everything else. */
  doorPort: number
  /** `name=token` lines, mode 0600 (`AGW_DOOR_TOKENS`, default `~/.agent-workflows/data/door-tokens`). */
  doorTokensFile: string
}

/** Every problem at once; values are never echoed. */
export function loadAudioProcessConfig(env: Env): AudioProcessConfig {
  const problems: string[] = []
  const base = readProcessConfig(env, { name: 'AGW_AUDIO_PORT', fallback: AUDIO_PORT }, problems)
  const home = env.HOME?.trim() || homedir()
  const stateDir = env.AGW_AUDIO_STATE_DIR?.trim() || join(home, '.local', 'state', 'agent-workflows-audio')
  const doorTokensFile = env.AGW_DOOR_TOKENS?.trim() || join(home, '.agent-workflows', 'data', 'door-tokens')
  // An ephemeral main port (port 0: a test, a probe) makes the unset door port ephemeral too, so it never takes 7793.
  const rawDoorPort = env.AGW_AUDIO_DOOR_PORT?.trim() || String(base.port === 0 ? 0 : AUDIO_DOOR_PORT)
  const doorPort = Number(rawDoorPort)
  if (!Number.isInteger(doorPort) || doorPort < 0 || doorPort > 65535)
    problems.push('AGW_AUDIO_DOOR_PORT must be an integer from 0 to 65535')
  else if (doorPort !== 0 && doorPort === base.port)
    problems.push('AGW_AUDIO_DOOR_PORT must differ from AGW_AUDIO_PORT')
  assertNoProblems(problems)
  return { ...base, stateDir, doorPort, doorTokensFile }
}
