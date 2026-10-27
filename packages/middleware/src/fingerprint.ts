import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { type RouteId, routeFingerprint } from '@agent-workflows/routes'
import type { Middleware } from '@agent-workflows/runtime'
import { type JournalDb, withRetry } from './db.ts'

/** One agent a workflow references: its definition files and the fingerprint of the route it runs on. */
export type AgentInputs = {
  name: string
  /** Path relative to the agent's directory (`AGENTS.md`, `skills/…`) → content. */
  files: Record<string, string>
  /** `routeFingerprint` of the agent's route (model, effort, overrides). */
  route: string
}

export type FingerprintInputs = { agents: AgentInputs[]; opencodeVersion: string | null }

/** Where the behaviour-changing inputs of a workflow come from. Production reads disk; tests pass a fake. */
export type FingerprintSource = {
  inputs(workflow: { id: string; version: string }): Promise<FingerprintInputs>
}

/** sha256 over the workflow version, each agent's files and route, and the OpenCode version (concept §5). */
export function computeFingerprint(version: string, inputs: FingerprintInputs): string {
  const agents = inputs.agents
    .map((a) => ({
      name: a.name,
      route: a.route,
      files: Object.keys(a.files)
        .sort()
        .map((path) => [path, sha256(a.files[path] ?? '')]),
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return sha256(JSON.stringify({ v: 1, version, agents, opencode: inputs.opencodeVersion }))
}

export type AgentRef = { agent: string; route: RouteId }

export type FsFingerprintOptions = {
  /** Compiled agent definitions: `<agentsDir>/<agent>/AGENTS.md` and `<agentsDir>/<agent>/skills/**`. */
  agentsDir: string
  /** The agents each workflow references, with the route each runs on. A workflow absent here has none. */
  workflows: Record<string, AgentRef[]>
  /** Default `opencode`. */
  opencodeBin?: string
  /** Route overrides are read from here. Default `process.env`. */
  env?: Record<string, string | undefined>
}

/**
 * Re-reads an agent's files only when their size or mtime changed (one directory walk and a `stat` per file per
 * admission), so an edited `AGENTS.md` or skill changes the fingerprint without a restart. `opencode --version`
 * runs once per process; a failed run is retried on the next admission. A workflow without agents never asks
 * OpenCode.
 */
export function fsFingerprintSource(options: FsFingerprintOptions): FingerprintSource {
  const agents = new Map<string, { signature: string; files: Record<string, string> }>()
  let opencode: Promise<string> | null = null

  const filesOf = async (agent: string) => {
    const dir = join(options.agentsDir, agent)
    const stats = await agentFiles(dir)
    const signature = JSON.stringify(stats)
    const hit = agents.get(agent)
    if (hit?.signature === signature) return hit.files
    const files: Record<string, string> = {}
    for (const [path] of stats) files[path] = await readFile(join(dir, path), 'utf8')
    agents.set(agent, { signature, files })
    return files
  }
  const opencodeVersion = () => {
    if (opencode) return opencode
    const load = readOpencodeVersion(options.opencodeBin ?? 'opencode')
    opencode = load
    load.catch(() => {
      if (opencode === load) opencode = null // only this failed load; never a newer one
    })
    return load
  }

  return {
    async inputs({ id }) {
      const refs = options.workflows[id] ?? []
      if (refs.length === 0) return { agents: [], opencodeVersion: null }
      const [version, ...files] = await Promise.all([opencodeVersion(), ...refs.map((r) => filesOf(r.agent))])
      return {
        agents: refs.map((r, i) => ({
          name: r.agent,
          files: files[i] ?? {},
          route: routeFingerprint(r.route, options.env ?? process.env),
        })),
        opencodeVersion: version ?? null,
      }
    },
  }
}

/** `AGENTS.md` (required) and every file under `skills/`, as `[relative path, size, mtimeMs]`, sorted. */
async function agentFiles(dir: string): Promise<[string, number, number][]> {
  const agentsMd = await stat(join(dir, 'AGENTS.md'))
  const out: [string, number, number][] = [['AGENTS.md', agentsMd.size, agentsMd.mtimeMs]]
  const skills = join(dir, 'skills')
  const entries = await readdir(skills, { recursive: true, withFileTypes: true }).catch((err: unknown) => {
    if ((err as { code?: string }).code === 'ENOENT') return []
    throw err
  })
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const path = join(entry.parentPath, entry.name)
    const info = await stat(path)
    out.push([relative(dir, path), info.size, info.mtimeMs])
  }
  return out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
}

async function readOpencodeVersion(bin: string): Promise<string> {
  const proc = Bun.spawn([bin, '--version'], { stdout: 'pipe', stderr: 'pipe', timeout: 15_000 })
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  const version = stdout.trim()
  if (code !== 0 || !version) throw new Error(`${bin} --version exited ${code} with "${version}"`)
  return version
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

/**
 * Computed on admission (`resume: false`) and written once (`fingerprint is null`), so a resumed run, or an
 * admission repeated after a crash before `admitted_at`, keeps the first value. The source read and the writes are
 * retried, so a blip does not refuse admission; a lasting failure refuses the run: a run whose behaviour inputs are
 * unknown cannot be compared.
 */
export function fingerprintMiddleware(options: {
  db: JournalDb
  source: FingerprintSource
  onFingerprint?: (runId: string, fingerprint: string) => void
}): Middleware {
  const { db, source } = options
  return {
    name: 'fingerprint',
    async runPre({ runId, workflowId, version, resume }) {
      if (resume) {
        const { rows } = await withRetry(() =>
          db.pool.query<{ fingerprint: string | null }>(`select fingerprint from ${db.runs} where id = $1`, [runId]),
        )
        const stored = rows[0]?.fingerprint
        if (stored) options.onFingerprint?.(runId, stored)
        return
      }
      const inputs = await withRetry(() => source.inputs({ id: workflowId, version }))
      const fingerprint = computeFingerprint(version, inputs)
      const { rows } = await withRetry(() =>
        db.pool.query<{ fingerprint: string }>(
          `update ${db.runs} set fingerprint = coalesce(fingerprint, $2), updated_at = now() where id = $1
           returning fingerprint`,
          [runId, fingerprint],
        ),
      )
      const stored = rows[0]?.fingerprint
      if (stored) options.onFingerprint?.(runId, stored)
    },
  }
}
