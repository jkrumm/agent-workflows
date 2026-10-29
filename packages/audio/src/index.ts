// The audio door and lanes as a library; the audio process (concept §8) mounts the two handlers and wires the usage
// port to its run record. The podcast's production stage calls the synth functions in-process on its own scope.
export {
  type AudioConfig,
  AudioConfigError,
  audioConfig,
  audioTransports,
  AUDIO_TUNING_DEFAULTS,
  type Env,
} from './config.ts'
export { createSpeechHandler, resolveTtsRoute } from './door/speech.ts'
export { createTranscriptionsHandler, resolveSttRoute } from './door/transcriptions.ts'
export {
  type AudioOutputFormat,
  type ChunkAudio,
  concatPcm,
  ffmpegMedia,
  type MediaPort,
  parseOutputFormat,
  SAMPLE_RATE_DEFAULT,
} from './media/audio.ts'
export { AUDIO_DEFAULT_ROUTES, AUDIO_ROUTES, type AudioRoute, type AudioRouteId } from './routes.pending.ts'
export { type AudioDeps, type AudioLog, AudioScope, type Clock, createAudioScope, type Fetch } from './scope.ts'
export {
  DELIVERY_KEYS,
  DELIVERY_STYLES,
  type DeliveryKey,
  endsOnQuestion,
  isDeliveryKey,
  resolveDelivery,
  SPEECH_TAGS,
  stripDisallowedTags,
  synthConcurrent,
} from './speech/core.ts'
export {
  GEMINI_VOICES,
  type MultiSpeakerPart,
  type MultiSpeakerVoices,
  multiSpeakerBody,
  synthMultiSpeaker,
} from './speech/gemini.ts'
export {
  ELEVENLABS_VOICES,
  type ReplicateChunkParams,
  type ReplicateChunkResult,
  ReplicateSynthError,
  synthReplicateChunk,
} from './speech/replicate.ts'
export {
  type CallEvent,
  type CostSource,
  priceCall,
  type RequestEvent,
  type Units,
  type UsageEvent,
  type UsagePort,
} from './usage.ts'
