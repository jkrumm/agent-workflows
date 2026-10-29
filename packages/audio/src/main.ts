// The audio process's entry: `scripts/launch.sh audio` under the LaunchAgent com.jkrumm.agent-workflows-audio.
import { installLifecycle, processLogger } from '@agent-workflows/host'
import { bootAudio, type DoorHandlers, loadAudioProcessConfig, readDoorTokens } from './process/index.ts'

const logger = processLogger('audio')

/**
 * The door handlers and their config (`src/door/`, `audioConfig` from `IU_API_KEY` and `IU_BASE_URL`), loaded at
 * start. Imported by URL until the lanes' package entry (`src/index.ts`) is on this branch's base; then this becomes a
 * static import. A missing or broken entry refuses the start, naming it.
 */
async function loadDoorHandlers(env: Record<string, string | undefined>): Promise<DoorHandlers> {
  const entry = new URL('./index.ts', import.meta.url).href
  const lanes = (await import(entry)) as {
    audioConfig?: (env: Record<string, string | undefined>) => unknown
    createSpeechHandler?: (deps: object) => (req: Request) => Promise<Response>
    createTranscriptionsHandler?: (deps: object) => (req: Request) => Promise<Response>
  }
  const { audioConfig, createSpeechHandler, createTranscriptionsHandler } = lanes
  if (!audioConfig || !createSpeechHandler || !createTranscriptionsHandler)
    throw new Error(`${entry} does not export audioConfig, createSpeechHandler and createTranscriptionsHandler`)
  const config = audioConfig(env)
  return {
    speech: (deps) => createSpeechHandler({ config, ...deps }),
    transcriptions: (deps) => createTranscriptionsHandler({ config, ...deps }),
  }
}

let started: Awaited<ReturnType<typeof bootAudio>>
let version = 'dev'
try {
  const config = loadAudioProcessConfig(process.env)
  version = config.version
  const tokens = readDoorTokens(config.doorTokensFile)
  const handlers = await loadDoorHandlers(process.env)
  started = await bootAudio({ config, handlers, tokens })
} catch (error) {
  logger.error(`start failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
console.log(`[agw-audio] listening on 127.0.0.1:${started.port} (${version})`)

// Deploys need no drain (concept §3): runs stay `running` and the next process resumes them.
installLifecycle({ shutdown: () => started.shutdown() })
