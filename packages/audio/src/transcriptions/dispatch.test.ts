import { describe, expect, test } from 'bun:test'
import { extractTextAndUsage, stripPromptEcho } from './dispatch.ts'
import { audioRoutes } from '../routes.ts'

const ROUTES = audioRoutes()

const PROMPT = 'Die Aufnahme ist auf Deutsch oder Englisch.'

describe('stripPromptEcho', () => {
  test('no-op when the prompt is empty', () => {
    expect(stripPromptEcho('Hallo Welt.', '')).toBe('Hallo Welt.')
  })

  test('no-op when the text does not contain the prompt', () => {
    expect(stripPromptEcho('Hallo Welt.', PROMPT)).toBe('Hallo Welt.')
  })

  test('removes a standalone echoed sentence at the start', () => {
    const text = `${PROMPT} Das war die eigentliche Aufnahme.`
    expect(stripPromptEcho(text, PROMPT)).toBe('Das war die eigentliche Aufnahme.')
  })

  test('removes a standalone echoed sentence in the middle', () => {
    const text = `Erster Satz. ${PROMPT} Letzter Satz.`
    expect(stripPromptEcho(text, PROMPT)).toBe('Erster Satz. Letzter Satz.')
  })

  test('removes a standalone echoed sentence at the end', () => {
    const text = `Erster Satz. ${PROMPT}`
    expect(stripPromptEcho(text, PROMPT)).toBe('Erster Satz.')
  })

  test('removes multiple occurrences', () => {
    const text = `${PROMPT} Mitte. ${PROMPT} Ende.`
    expect(stripPromptEcho(text, PROMPT)).toBe('Mitte. Ende.')
  })

  test('tolerates a trailing punctuation mismatch (echoed without the period)', () => {
    const core = PROMPT.replace(/\.$/, '')
    const text = `${core} Weiter geht's.`
    expect(stripPromptEcho(text, PROMPT)).toBe("Weiter geht's.")
  })

  test("leaves the prompt's words untouched when embedded inside a larger sentence", () => {
    const text = `Er sagte, ${PROMPT} und legte auf.`
    expect(stripPromptEcho(text, PROMPT)).toBe(text)
  })

  test('collapses whitespace left behind, no double spaces or leading/trailing space', () => {
    const text = `  ${PROMPT}   Danach kam noch etwas.  `
    const result = stripPromptEcho(text, PROMPT)
    expect(result).not.toMatch(/ {2,}/)
    expect(result).toBe(result.trim())
    expect(result).toBe('Danach kam noch etwas.')
  })

  // Regression: the pattern consumes the preceding sentence's terminator as
  // its lead, so a single pass left the second of two adjacent echoes in
  // place — observed in production on a collapsed chunk.
  test('removes back-to-back echoes, not just the first', () => {
    const prompt = 'Die Aufnahme ist auf Deutsch oder Englisch.'
    const two =
      'Ein Satz. Die Aufnahme ist auf Deutsch oder Englisch. Die Aufnahme ist auf Deutsch oder Englisch. Danach.'
    expect(stripPromptEcho(two, prompt)).toBe('Ein Satz. Danach.')
    const three =
      'A. Die Aufnahme ist auf Deutsch oder Englisch. Die Aufnahme ist auf Deutsch oder Englisch. Die Aufnahme ist auf Deutsch oder Englisch. B.'
    expect(stripPromptEcho(three, prompt)).toBe('A. B.')
  })
})

describe('extractTextAndUsage', () => {
  test('parses a JSON body', () => {
    const out = extractTextAndUsage(
      JSON.stringify({ text: 'hi', usage: { seconds: 1 }, language: 'de' }),
      'application/json',
    )
    expect(out.text).toBe('hi')
    expect(out.language).toBe('de')
  })

  test('reads language from a languages[].code list (the OpenAI transcribe shape) and keeps its duration usage', () => {
    const body = JSON.stringify({
      text: 'hallo',
      languages: [{ code: 'de' }],
      usage: { type: 'duration', seconds: 240 },
    })
    const out = extractTextAndUsage(body, 'application/json')
    expect(out.text).toBe('hallo')
    expect(out.language).toBe('de')
    expect(out.usage).toEqual({ type: 'duration', seconds: 240 })
  })

  test('parses a voxtral body: null language stays null, prompt_audio_seconds usage is kept', () => {
    const body = JSON.stringify({
      model: ROUTES['audio.stt.voxtral-mini'].model,
      text: 'hallo',
      language: null,
      segments: [],
      usage: { prompt_audio_seconds: 6, prompt_tokens: 5, completion_tokens: 14, total_tokens: 394 },
      finish_reason: null,
    })
    const out = extractTextAndUsage(body, 'application/json')
    expect(out.text).toBe('hallo')
    expect(out.language).toBeNull()
    expect((out.usage as Record<string, unknown>).prompt_audio_seconds).toBe(6)
  })

  test('passes a non-JSON body through as raw text', () => {
    const out = extractTextAndUsage('1\n00:00:00,000 --> 00:00:01,000\nhi\n', 'text/plain')
    expect(out.text).toBe('1\n00:00:00,000 --> 00:00:01,000\nhi\n')
    expect(out.usage).toBeNull()
    expect(out.language).toBeNull()
  })
})
