import { readVoiceGuide, VOICE_PATH_ENV, voiceGuidePath } from '@agent-workflows/capabilities'
import { WorkflowError } from '@agent-workflows/runtime'

export { VOICE_PATH_ENV, voiceGuidePath as voicePath }

/** The voice guide cannot be read: a configuration failure, not a verdict on the draft. Names the variable. */
export class VoiceGuideError extends WorkflowError {
  override name = 'VoiceGuideError'
  constructor(cause: unknown) {
    super('error', (cause as Error).message, { cause })
  }
}

/**
 * Reads the guide to prove the writer will find it; the review itself does not carry it (legacy's did not). The path and
 * the read are the capabilities package's (`prose.write` reads the same file): one default, one variable.
 */
export async function checkVoiceGuide(env: Record<string, string | undefined> = process.env): Promise<string> {
  try {
    await readVoiceGuide(env, true)
  } catch (error) {
    throw new VoiceGuideError(error)
  }
  return voiceGuidePath(env)
}
