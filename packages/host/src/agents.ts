import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { AgentDefinition } from '@agent-workflows/opencode-host'
import { routeIds } from '@agent-workflows/routes'
import { z } from 'zod'

/**
 * `agents/<name>/agent.json`: what an agent needs beyond its `AGENTS.md` and `skills/**`. The same directory feeds the
 * run fingerprint (`fsFingerprintSource`), so what the OpenCode host serves and what the fingerprint hashes are one
 * source.
 */
const AgentJson = z
  .object({
    route: z.string().optional(),
    permissions: z
      .object({
        shell: z.boolean().optional(),
        rules: z
          .array(z.object({ action: z.string(), resource: z.string(), effect: z.enum(['allow', 'deny']) }).strict())
          .optional(),
      })
      .strict()
      .optional(),
    config: z.record(z.string(), z.json()).optional(),
  })
  .strict()

const NAME = /^[a-z0-9][a-z0-9._-]*$/

function filesUnder(dir: string, root = dir): Record<string, string> {
  const files: Record<string, string> = {}
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) Object.assign(files, filesUnder(path, root))
    else if (entry.isFile()) files[relative(root, path)] = readFileSync(path, 'utf8')
  }
  return files
}

/**
 * Every agent under `dir`: one directory per agent with an `AGENTS.md`, optional `skills/**` and `agent.json`.
 * A missing `dir` means no agents. A broken definition throws, so a bad agent fails the start, not its first step.
 */
export function loadAgentDefinitions(dir: string): AgentDefinition[] {
  if (!existsSync(dir)) return []
  const routes = new Set<string>(routeIds())
  const definitions: AgentDefinition[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const name = entry.name
    const base = join(dir, name)
    const agentsMd = join(base, 'AGENTS.md')
    if (!existsSync(agentsMd)) continue
    if (!NAME.test(name)) throw new Error(`agent "${name}": the directory name is not a valid agent name`)
    const jsonPath = join(base, 'agent.json')
    const meta = existsSync(jsonPath) ? AgentJson.parse(JSON.parse(readFileSync(jsonPath, 'utf8'))) : {}
    if (meta.route !== undefined && !routes.has(meta.route)) {
      throw new Error(`agent "${name}": unknown route "${meta.route}"`)
    }
    const skillsDir = join(base, 'skills')
    definitions.push({
      name,
      agentsMd: readFileSync(agentsMd, 'utf8'),
      ...(existsSync(skillsDir) ? { skills: filesUnder(skillsDir) } : {}),
      ...(meta.config ? { config: meta.config } : {}),
      ...(meta.route ? { route: meta.route as AgentDefinition['route'] } : {}),
      ...(meta.permissions ? { permissions: meta.permissions } : {}),
    })
  }
  return definitions.sort((a, b) => a.name.localeCompare(b.name))
}
