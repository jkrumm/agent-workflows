import { deflateSync } from 'node:zlib'

const u32 = (n: number) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255])

function chunk(type: string, data: Uint8Array): Uint8Array {
  const body = new Uint8Array(4 + data.length)
  body.set(new TextEncoder().encode(type), 0)
  body.set(data, 4)
  return Buffer.concat([u32(data.length), body, u32(Bun.hash.crc32(body))])
}

export type PngFilter = 0 | 1 | 2 | 3 | 4

const paeth = (a: number, b: number, c: number) => {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/**
 * A real, decodable PNG for tests: `width` x `height`. `rgba` has an alpha channel (colour type 6) whose value is `alpha`
 * everywhere or `alphaAt(x, y)`, otherwise it is RGB (type 2). `palette` makes a one-colour indexed PNG with a `tRNS` chunk
 * (type 3). `filter` encodes every row with that PNG row filter (0 none, 1 sub, 2 up, 3 average, 4 paeth).
 */
export function pngFixture(
  width: number,
  height: number,
  options: {
    kind?: 'rgba' | 'rgb' | 'palette'
    alpha?: number
    alphaAt?: (x: number, y: number) => number
    filter?: PngFilter
  } = {},
): Uint8Array<ArrayBuffer> {
  const kind = options.kind ?? 'rgba'
  const colorType = kind === 'rgba' ? 6 : kind === 'rgb' ? 2 : 3
  const channels = kind === 'rgba' ? 4 : kind === 'rgb' ? 3 : 1
  const pixel = (x: number, y: number) =>
    kind === 'rgba'
      ? [
          200 - ((x * 7 + y * 3) % 50),
          40 + ((x + y) % 60),
          40,
          options.alphaAt ? options.alphaAt(x, y) : (options.alpha ?? 255),
        ]
      : kind === 'rgb'
        ? [200 - ((x * 7 + y * 3) % 50), 40 + ((x + y) % 60), 40]
        : [0]
  const filter = options.filter ?? 0
  const stride = width * channels
  const rows: Buffer[] = []
  let previous = Buffer.alloc(stride)
  for (let y = 0; y < height; y++) {
    const row = Buffer.from(Array.from({ length: width }, (_, x) => pixel(x, y)).flat())
    const filtered = Buffer.alloc(stride + 1)
    filtered[0] = filter
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? (row[i - channels] ?? 0) : 0
      const b = previous[i] ?? 0
      const c = i >= channels ? (previous[i - channels] ?? 0) : 0
      const predictor = [0, a, b, (a + b) >> 1, paeth(a, b, c)][filter] ?? 0
      filtered[i + 1] = ((row[i] ?? 0) - predictor) & 255
    }
    rows.push(filtered)
    previous = row
  }
  const ihdr = Buffer.concat([u32(width), u32(height), Buffer.from([8, colorType, 0, 0, 0])])
  const parts: Uint8Array[] = [
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    ...(kind === 'palette'
      ? [chunk('PLTE', Buffer.from([200, 40, 40])), chunk('tRNS', Buffer.from([options.alpha ?? 128]))]
      : []),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', new Uint8Array()),
  ]
  return new Uint8Array(Buffer.concat(parts))
}

/** The same picture as a lossless WebP (what a recraft cutout delivers). */
export async function webpFixture(
  width: number,
  height: number,
  alphaAt?: (x: number, y: number) => number,
): Promise<Uint8Array<ArrayBuffer>> {
  const bytes = await new Bun.Image(pngFixture(width, height, { alphaAt })).webp({ lossless: true }).bytes()
  return new Uint8Array(bytes)
}

export const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64')

/** What the fake endpoint saw of a request: JSON bodies parsed, multipart bodies as `FormData`. */
export interface SeenRequest {
  path: string
  headers: Headers
  json?: Record<string, unknown>
  form?: FormData
}
export type FakeHandler = (request: SeenRequest, attempt: number) => Response | Promise<Response>

export interface FakeImageServer {
  /** The value for `IU_BASE_URL`; the images API is `/openai/v1/images/*`, Replicate `/replicate/v1/*` on the same host. */
  baseUrl: string
  seen: SeenRequest[]
  /** Requests answered so far, by path. */
  attempts: Record<string, number>
  on(path: string, handler: FakeHandler): void
  /** Forget handlers, history and counts between tests. */
  reset(): void
  stop(): void
}

/** An in-test HTTP server answering like the IU endpoint, on a real socket so the production adapters run over HTTP. */
export function startFakeImageServer(): FakeImageServer {
  const state = {
    handlers: {} as Record<string, FakeHandler>,
    seen: [] as SeenRequest[],
    attempts: {} as Record<string, number>,
  }
  const server = Bun.serve({
    port: 0,
    // Loopback only: a wildcard bind can share its port with another process's 127.0.0.1 bind under parallel test files.
    hostname: '127.0.0.1',
    async fetch(req) {
      const path = new URL(req.url).pathname
      const handler = state.handlers[path]
      if (!handler) return new Response(`fake IU: nothing for ${path}`, { status: 404 })
      const type = req.headers.get('content-type') ?? ''
      const record: SeenRequest = { path, headers: req.headers }
      if (type.startsWith('multipart/')) record.form = await req.formData()
      else if (type.includes('json')) record.json = (await req.json()) as Record<string, unknown>
      state.seen.push(record)
      const response = await handler(record, state.attempts[path] ?? 0)
      state.attempts[path] = (state.attempts[path] ?? 0) + 1
      const headers = new Headers(response.headers)
      // Never keep-alive: a later fake server can be given this port, and a pooled socket to the stopped one would fail.
      headers.set('connection', 'close')
      return new Response(response.body, { status: response.status, headers })
    },
  })
  return {
    baseUrl: `http://127.0.0.1:${server.port}/anthropic`,
    get seen() {
      return state.seen
    },
    get attempts() {
      return state.attempts
    },
    on: (path, handler) => {
      state.handlers[path] = handler
    },
    reset() {
      state.handlers = {}
      state.seen = []
      state.attempts = {}
    },
    stop() {
      void server.stop(true)
    },
  }
}
