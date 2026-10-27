import type { OpenCodeMessage } from '../../src/index.ts'

/**
 * Message pages shaped like OpenCode v2's `GET /api/session/:id/message` `data[]`. S2 captured no prompted session
 * (every prompt wedged, REPORT §5), so the shapes come from the measured sources it points at: the per-message
 * token block of a live `deepseek-v4.1-flash` message (usage-tracker `opencode.test.ts`, measured 2026-09-24:
 * `input` excludes the cache, `total = input + output + reasoning + cache.read + cache.write`) and agent-gateway's
 * v2 probe (`type: assistant`, `content[]` with `tool` blocks, a trailing `idle` message; 2026-10-14).
 */

/** One turn, cache-heavy, no reasoning, priced. */
export const cachedTurn: OpenCodeMessage[] = [
  { type: 'user', content: [{ type: 'text' }] },
  {
    type: 'assistant',
    modelID: 'deepseek-v4.1-flash',
    cost: 0.000103878,
    tokens: { input: 257, output: 2, reasoning: 0, cache: { write: 0, read: 21376 } },
    content: [{ type: 'text' }],
  },
  { type: 'idle' },
]

/** Two turns: a tool call, then the answer; reasoning on both, a cache write on the first. */
export const toolTurns: OpenCodeMessage[] = [
  { type: 'user', content: [{ type: 'text' }] },
  {
    type: 'assistant',
    cost: 0.0021,
    tokens: { input: 1200, output: 40, reasoning: 300, cache: { read: 800, write: 64 } },
    content: [{ type: 'reasoning' }, { type: 'tool' }, { type: 'tool' }],
  },
  {
    type: 'assistant',
    cost: 0.0009,
    tokens: { input: 150, output: 25, reasoning: 60, cache: { read: 2000, write: 0 } },
    content: [{ type: 'reasoning' }, { type: 'text' }],
  },
  { type: 'idle' },
]

/** A config without `cost` rows: the second message carries no price. */
export const partlyPriced: OpenCodeMessage[] = [
  { type: 'assistant', cost: 0.001, tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } } },
  { type: 'assistant', tokens: { input: 20, output: 5, reasoning: 0, cache: { read: 0, write: 0 } } },
]
