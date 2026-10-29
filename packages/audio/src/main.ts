// The audio process's entry: `scripts/launch.sh audio` under the LaunchAgent com.jkrumm.agent-workflows-audio.
import { installLifecycle, processLogger } from '@agent-workflows/host'
import { type AudioDeps, audioConfig, createSpeechHandler, createTranscriptionsHandler, ffmpegMedia } from './index.ts'
import { bootAudio, type DoorHandlers, loadAudioProcessConfig, readDoorTokens } from './process/index.ts'

const logger = processLogger('audio')

/**
 * The lanes' deps on one config and one media port (`audioConfig` from `IU_API_KEY` and `IU_BASE_URL`; a bad value
 * refuses the start): the door builds one handler per request with that request's deps, the podcast's production
 * synthesizes on the same.
 */
function lanes(env: Record<string, string | undefined>): { audio: Omit<AudioDeps, 'usage'>; handlers: DoorHandlers } {
  const config = audioConfig(env)
  const media = ffmpegMedia({ mp3BitrateKbps: config.ttsBitrateKbps, opusBitrateKbps: config.ttsOpusBitrateKbps })
  return {
    audio: { config, media, env },
    handlers: {
      speech: (deps) => createSpeechHandler({ config, media, env, ...deps }),
      transcriptions: (deps) => createTranscriptionsHandler({ config, media, env, ...deps }),
    },
  }
}

let started: Awaited<ReturnType<typeof bootAudio>>
let version = 'dev'
try {
  const config = loadAudioProcessConfig(process.env)
  version = config.version
  const tokens = readDoorTokens(config.doorTokensFile)
  const { audio, handlers } = lanes(process.env)
  started = await bootAudio({ config, handlers, tokens, audio })
} catch (error) {
  logger.error(`start failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
console.log(`[agw-audio] listening on 127.0.0.1:${started.port} (${version})`)

// Deploys need no drain (concept §3): runs stay `running` and the next process resumes them.
installLifecycle({
  shutdown: () => started.shutdown(),
  log: (message, meta) => console.error(`[agw-audio] ${message}`, meta ?? ''),
})
