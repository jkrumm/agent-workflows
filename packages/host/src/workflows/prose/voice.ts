import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { WorkflowError } from '@agent-workflows/runtime'

export const VOICE_PATH_ENV = 'AGW_VOICE_PATH'

/** The voice guide (the brain vault's `voice.md`), unless the environment names another file. */
export function voicePath(env: Record<string, string | undefined> = process.env): string {
  return env[VOICE_PATH_ENV]?.trim() || join(homedir(), 'SourceRoot', 'brain', 'voice.md')
}

/** The voice guide cannot be read: a configuration failure, not a verdict on the draft. Names the variable. */
export class VoiceGuideError extends WorkflowError {
  override name = 'VoiceGuideError'
  constructor(path: string, cause: unknown) {
    super('error', `voice guide not readable at ${path} (set ${VOICE_PATH_ENV}): ${(cause as Error).message}`, {
      cause,
    })
  }
}

/** Reads the guide to prove the calling session will find it; the review itself does not carry it (legacy's did not). */
export async function checkVoiceGuide(env: Record<string, string | undefined> = process.env): Promise<string> {
  const path = voicePath(env)
  try {
    const text = await readFile(path, 'utf8')
    if (!text.trim()) throw new Error('the file is empty')
  } catch (error) {
    throw new VoiceGuideError(path, error)
  }
  return path
}
