// The world outside the runtime for the kill harness: probes, a Postgres-backed fake agent server, effects and
// the ledger. It lives in harness tables (h_*) inside the scenario's schema, so it survives worker deaths.
import type { Pool } from 'pg'
import type { AgentHost, AgentResult, AgentWaitOptions, Json, Middleware } from '../../src/index.ts'

export const HARNESS_SQL = (s: string) => `
create table "${s}".h_probes (id bigserial primary key, run_id text not null, step text not null, ev text not null,
  pid int not null, version text not null, at timestamptz not null default clock_timestamp());
create table "${s}".h_commits (run_id text not null, step_id text not null, pid int not null,
  at timestamptz not null default clock_timestamp());
create table "${s}".h_sessions (id text primary key, run_id text not null, step_id text not null,
  duration_ms int not null, prompted_at timestamptz, aborted_at timestamptz);
create table "${s}".h_prompts (session_id text not null, run_id text not null, outcome text not null);
create table "${s}".h_effects (key text primary key, run_id text not null);
create table "${s}".h_effect_attempts (key text not null, run_id text not null, outcome text not null);
create table "${s}".h_peak (pid int primary key, peak int not null);
`

/** KILL_AT="<runIdPrefix>|<step>|<ev>|<delayMs>|<signal>": the worker kills itself at that probe, once. */
export type KillAt = { run: string; step: string; ev: string; delayMs: number; signal: 'SIGKILL' | 'SIGTERM' }

export function parseKillAt(raw: string | undefined): KillAt | null {
  if (!raw) return null
  const [run = '', step = '', ev = '', delay = '0', signal = 'SIGKILL'] = raw.split('|')
  return { run, step, ev, delayMs: Number(delay), signal: signal as KillAt['signal'] }
}

export class World {
  private killArmed: boolean

  constructor(
    readonly pool: Pool,
    readonly schema: string,
    readonly version: string,
    private readonly kill: KillAt | null,
    readonly agentMs: number,
  ) {
    this.killArmed = kill !== null
  }

  private t(name: string) {
    return `"${this.schema}".${name}`
  }

  async probe(runId: string, step: string, ev: string) {
    await this.pool.query(
      `insert into ${this.t('h_probes')} (run_id, step, ev, pid, version) values ($1,$2,$3,$4,$5)`,
      [runId, step, ev, process.pid, this.version],
    )
    const k = this.kill
    if (!k || !this.killArmed || !runId.startsWith(k.run) || k.step !== step || k.ev !== ev) return
    this.killArmed = false
    const fire = () => {
      process.kill(process.pid, k.signal)
    }
    if (k.delayMs > 0) setTimeout(fire, k.delayMs)
    else fire()
    if (k.signal === 'SIGKILL' && k.delayMs === 0) await new Promise(() => {}) // never continue past a kill point
  }

  async effect(runId: string, key: string): Promise<'inserted' | 'duplicate'> {
    const { rowCount } = await this.pool.query(
      `insert into ${this.t('h_effects')} (key, run_id) values ($1, $2) on conflict (key) do nothing`,
      [key, runId],
    )
    const outcome = rowCount === 1 ? 'inserted' : 'duplicate'
    await this.pool.query(`insert into ${this.t('h_effect_attempts')} (key, run_id, outcome) values ($1,$2,$3)`, [
      key,
      runId,
      outcome,
    ])
    return outcome
  }

  /** Records every committed step (stepPost after the journal commit) and the peak of concurrent top-level runs. */
  ledgerMiddleware(): Middleware {
    let active = 0
    let peak = 0
    return {
      name: 'ledger',
      runPre: async (a) => {
        if (a.parentId !== null) return
        active++
        if (active <= peak) return
        peak = active
        await this.pool.query(
          `insert into ${this.t('h_peak')} (pid, peak) values ($1, $2)
           on conflict (pid) do update set peak = greatest(${this.t('h_peak')}.peak, $2)`,
          [process.pid, peak],
        )
      },
      runPost: (a) => {
        if (a.parentId === null) active--
      },
      stepPost: async (a) => {
        if (a.status !== 'done') return
        await this.pool.query(`insert into ${this.t('h_commits')} (run_id, step_id, pid) values ($1,$2,$3)`, [
          a.runId,
          a.stepId,
          process.pid,
        ])
      },
    }
  }

  /**
   * A fake OpenCode server as rows: a session runs for agentMs from its prompt whether or not anyone waits,
   * so a restarted worker re-attaches by session id. The prompt send is idempotent (`prompted_at is null`).
   */
  host(): AgentHost {
    const sessions = this.t('h_sessions')
    const prompts = this.t('h_prompts')
    const sessionOf = (handle: Json) => (handle as { sessionId: string }).sessionId
    return {
      open: async (spec) => {
        await this.probe(spec.runId, 'agent.open', 'start')
        const id = `ses_${crypto.randomUUID()}`
        await this.pool.query(`insert into ${sessions} (id, run_id, step_id, duration_ms) values ($1,$2,$3,$4)`, [
          id,
          spec.runId,
          spec.stepId,
          this.agentMs,
        ])
        await this.probe(spec.runId, 'agent.open', 'end')
        return { sessionId: id }
      },
      prompt: async (handle) => {
        const id = sessionOf(handle)
        const res = await this.pool.query<{ run_id: string }>(
          `update ${sessions} set prompted_at = clock_timestamp() where id = $1 and prompted_at is null returning run_id`,
          [id],
        )
        const runId =
          res.rows[0]?.run_id ??
          (await this.pool.query<{ run_id: string }>(`select run_id from ${sessions} where id = $1`, [id])).rows[0]
            ?.run_id
        await this.pool.query(`insert into ${prompts} (session_id, run_id, outcome) values ($1,$2,$3)`, [
          id,
          runId,
          res.rowCount === 1 ? 'sent' : 'noop',
        ])
      },
      wait: async (handle, options: AgentWaitOptions): Promise<AgentResult> => {
        const id = sessionOf(handle)
        let first = true
        for (;;) {
          options.signal.throwIfAborted()
          const { rows } = await this.pool.query<{ run_id: string; ms: number; duration_ms: number }>(
            `select run_id, extract(epoch from clock_timestamp() - prompted_at) * 1000 as ms, duration_ms
             from ${sessions} where id = $1`,
            [id],
          )
          const row = rows[0]
          if (!row) throw new Error(`unknown session ${id}`)
          if (first) {
            first = false
            await this.probe(row.run_id, 'agent', 'start')
          }
          options.onProgress()
          if (Number(row.ms) >= row.duration_ms) {
            await this.probe(row.run_id, 'agent', 'end')
            return {
              output: `answer from ${id}`,
              usage: { model: 'fake', tokens: { input: 100, output: 10, cacheRead: 0, reasoning: 0 }, cost: 0.001 },
            }
          }
          await Bun.sleep(50)
        }
      },
      steer: async () => {},
      abort: async (handle) => {
        await this.pool.query(`update ${sessions} set aborted_at = clock_timestamp() where id = $1`, [
          sessionOf(handle),
        ])
      },
    }
  }
}
