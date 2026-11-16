export const WALL_INTERVAL_MS = 30 * 60_000

/**
 * The hosts whose last read ended at a wall (a challenge nobody passed, a bot block), each with its reason, for the
 * wall interval (30 minutes). A read of such a host is answered from here without a browser or a paid read: the wall is still
 * up, and the 20 s settle plus a Tavily call that fails too is what every repeat would otherwise cost. A read that
 * passes clears it.
 */
export class WallMemory<R extends string = string> {
  private readonly walls = new Map<string, { reason: R; at: number }>()

  /** `ttlMs`: how long a host is remembered (default the wall interval). */
  constructor(private readonly ttlMs = WALL_INTERVAL_MS) {}

  remember(host: string, reason: R, now = Date.now()): void {
    for (const [other, wall] of this.walls) if (now - wall.at >= this.ttlMs) this.walls.delete(other)
    this.walls.set(host, { reason, at: now })
  }

  /** The wall still standing at `host`: its reason and when it was met; undefined once the interval is over. */
  recall(host: string, now = Date.now()): { reason: R; at: number } | undefined {
    const wall = this.walls.get(host)
    if (!wall) return undefined
    if (now - wall.at < this.ttlMs) return wall
    this.walls.delete(host)
    return undefined
  }

  clear(host: string): void {
    this.walls.delete(host)
  }
}
