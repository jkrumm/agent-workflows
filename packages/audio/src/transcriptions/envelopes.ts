// verbose_json / srt / vtt for models that answer only json/text, and for joined multi-part transcripts (no real
// segment timing exists there): one segment spanning the clip.

export const srtTime = (s: number): string => {
  const ms = Math.max(0, Math.round(s * 1000))
  const h = String(Math.floor(ms / 3_600_000)).padStart(2, '0')
  const m = String(Math.floor((ms % 3_600_000) / 60_000)).padStart(2, '0')
  const sec = String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0')
  const milli = String(ms % 1000).padStart(3, '0')
  return `${h}:${m}:${sec},${milli}`
}

export const verboseJson = (text: string, duration: number, language: string | null) => ({
  task: 'transcribe',
  language: language ?? 'unknown',
  duration,
  text,
  segments: [
    {
      id: 0,
      seek: 0,
      start: 0,
      end: duration,
      text,
      tokens: [] as number[],
      temperature: 0,
      avg_logprob: 0,
      compression_ratio: 1,
      no_speech_prob: 0,
    },
  ],
})

export const srt = (text: string, duration: number): string => `1\n${srtTime(0)} --> ${srtTime(duration)}\n${text}\n`

export const vtt = (text: string, duration: number): string =>
  `WEBVTT\n\n${srtTime(0).replace(',', '.')} --> ${srtTime(duration).replace(',', '.')}\n${text}\n`
