import { Client } from 'pg'
import { errorMessage, InfraError } from './errors.ts'
import type { Logger } from './types.ts'

/** 64-bit advisory lock key: the first 8 bytes of sha256, as a signed bigint string for `$1::bigint`. */
export function lockKey(name: string): string {
  const digest = new Bun.CryptoHasher('sha256').update(name).digest()
  return new DataView(digest.buffer, digest.byteOffset, 8).getBigInt64(0).toString()
}

export type Lease = {
  /** Fires once when the lease connection errors or ends: the run must stop writing. */
  onLost(listener: () => void): void
  /** Unlocks and returns the connection; never throws. */
  release(): Promise<void>
}

type LeaseClient = { client: Client; dead: boolean; onLost: (() => void) | null }

const MAX_IDLE = 4

/**
 * Held advisory locks, one per top-level run, on connections of their own: never the journal pool, so a full
 * set of leases cannot starve journal queries (the spike's pool deadlock). Sized to the process concurrency
 * limit; beyond it `tryLock` answers `full` and the run stays queued for the next tick.
 */
export class LeasePool {
  private held = 0
  private idle: LeaseClient[] = []
  private closed = false

  constructor(
    private readonly connectionString: string,
    private readonly max: number,
    private readonly applicationName: string,
    private readonly logger: Logger,
  ) {}

  free(): number {
    return this.closed ? 0 : this.max - this.held
  }

  async tryLock(key: string): Promise<Lease | 'full' | 'busy'> {
    if (this.free() <= 0) return 'full'
    this.held++
    let lc: LeaseClient | null = null
    try {
      lc = await this.checkout()
      const { rows } = await lc.client.query<{ ok: boolean }>('select pg_try_advisory_lock($1::bigint) as ok', [key])
      if (rows[0]?.ok) return this.lease(lc, key)
      this.checkin(lc)
      this.held--
      return 'busy'
    } catch (err) {
      if (lc) this.discard(lc)
      this.held--
      throw new InfraError(`lease: ${errorMessage(err)}`, { cause: err })
    }
  }

  async close() {
    this.closed = true
    const idle = this.idle.splice(0)
    await Promise.allSettled(idle.map((lc) => lc.client.end()))
  }

  private lease(lc: LeaseClient, key: string): Lease {
    let released = false
    return {
      onLost: (listener) => {
        if (lc.dead) listener()
        else lc.onLost = listener
      },
      release: async () => {
        if (released) return
        released = true
        lc.onLost = null
        this.held--
        if (lc.dead) return this.discard(lc)
        try {
          await lc.client.query('select pg_advisory_unlock($1::bigint)', [key])
          this.checkin(lc)
        } catch (err) {
          this.logger.warn('lease: unlock failed, dropping the connection', { error: errorMessage(err) })
          this.discard(lc)
        }
      },
    }
  }

  private async checkout(): Promise<LeaseClient> {
    const idle = this.idle.pop()
    if (idle) return idle
    const client = new Client({
      connectionString: this.connectionString,
      application_name: this.applicationName,
      keepAlive: true,
      connectionTimeoutMillis: 30_000,
      query_timeout: 60_000,
      statement_timeout: 60_000,
    })
    const lc: LeaseClient = { client, dead: false, onLost: null }
    const lost = () => {
      if (lc.dead) return
      lc.dead = true
      this.idle = this.idle.filter((c) => c !== lc)
      lc.onLost?.()
    }
    client.on('error', (err) => {
      this.logger.warn('lease connection lost', { error: errorMessage(err) })
      lost()
    })
    client.on('end', lost)
    await client.connect()
    return lc
  }

  private checkin(lc: LeaseClient) {
    if (lc.dead || this.closed || this.idle.length >= MAX_IDLE) return this.discard(lc)
    this.idle.push(lc)
  }

  private discard(lc: LeaseClient) {
    lc.onLost = null
    lc.dead = true
    lc.client.end().catch(() => {})
  }
}
