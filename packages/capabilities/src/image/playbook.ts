import { readFileSync } from 'node:fs'

/**
 * image-gateway's versioned playbook (`packages/capabilities/playbook/*.md`, copied from its `shared/playbook/`): the
 * doctrine the planner is conditioned on. Bumped whenever a file changes in a way that affects planner output; every plan
 * echoes it. The files sit outside `src/` on purpose: they name the image models, and model ids live only in the route table.
 */
export const PLAYBOOK_VERSION = '5'

const CORE_SECTIONS = ['core', 'settings', 'policy'] as const
export const INTENTS = [
  'auto',
  'icon',
  'hero',
  'painterly',
  'technical',
  'diagram',
  'article',
  'figure-art',
  'texture',
] as const
export type Intent = (typeof INTENTS)[number]

/** The `icon` intent's file is `icons` (plural); every other intent matches its filename. */
const FILE_OF: Partial<Record<Intent, string>> = { icon: 'icons' }

const read = (key: string): string =>
  readFileSync(new URL(`../../playbook/${key}.md`, import.meta.url), 'utf8').trimEnd()

/** The core sections plus the intent's own file (none for `auto`: the model detects the intent), joined by rules. */
export function composePlaybook(intent: Intent): string {
  const keys = intent === 'auto' ? [...CORE_SECTIONS] : [...CORE_SECTIONS, FILE_OF[intent] ?? intent]
  return keys.map(read).join('\n\n---\n\n')
}
