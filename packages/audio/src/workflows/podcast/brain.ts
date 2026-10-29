import type { BrainPort } from './ports.ts'

// The vault through the platform's capabilities `brain.search` and `brain.read`, called in-process (`call`): the same
// validation and path containment (`wiki/`, `Areas/`, `Projects/`, no dotfiles, real path inside the vault) as for an
// agent behind the tool gate. Typed structurally on the two calls, so the adapter takes whatever registry holds them.

interface SearchCall {
  call(
    input: { query: string; maxResults?: number },
    options?: { signal?: AbortSignal },
  ): Promise<{
    matches: { path: string; line: number; snippet: string }[]
    warnings: string[]
  }>
}

interface ReadCall {
  call(
    input: { note: string; maxChars?: number },
    options?: { signal?: AbortSignal },
  ): Promise<
    | { found: true; path: string; frontmatter: string; body: string; truncated: boolean }
    | { found: false; reason: string }
  >
}

export interface BrainCapabilities {
  search: SearchCall
  read: ReadCall
}

/** The two vault capabilities out of a capability list (`createCapabilities()` or a host registry's). */
export function brainCapabilities(capabilities: readonly { id: string }[]): BrainCapabilities {
  const find = (id: string) => {
    const found = capabilities.find((c) => c.id === id)
    if (!found) throw new Error(`capability ${id} is not registered`)
    return found
  }
  return { search: find('brain.search') as unknown as SearchCall, read: find('brain.read') as unknown as ReadCall }
}

export function brainPort(capabilities: BrainCapabilities): BrainPort {
  return {
    async search(query, limit, signal) {
      const result = await capabilities.search.call({ query, maxResults: limit }, { signal })
      return { matches: result.matches, warnings: result.warnings }
    },
    async read(path, maxChars, signal) {
      const note = await capabilities.read.call({ note: path, maxChars }, { signal })
      if (!note.found) return { found: false, reason: note.reason }
      const { frontmatter, body, truncated } = note
      return { found: true, path: note.path, frontmatter, body, truncated }
    },
  }
}
