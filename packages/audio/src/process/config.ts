import { homedir } from 'node:os'
import { join } from 'node:path'
import { assertNoProblems, type Env, type ProcessConfig, readProcessConfig } from '@agent-workflows/host'

export const AUDIO_PORT = 7792

/** The audio process: the shared process settings on its own port, its own state dir and the door's caller tokens. */
export interface AudioProcessConfig extends ProcessConfig {
  /**
   * The tool gate's and the (lazy) agent host's state dir (`AGW_AUDIO_STATE_DIR`). Never the host's: two tool gates
   * sharing one `gate.json` would overwrite each other's address and key.
   */
  stateDir: string
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
  assertNoProblems(problems)
  return { ...base, stateDir, doorTokensFile }
}
