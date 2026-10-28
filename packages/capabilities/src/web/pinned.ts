import { type IncomingMessage, request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { pipeline, Readable } from 'node:stream'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'

// A request that connects to an address the SSRF guard already vetted. `fetch` resolves the name itself at connect
// time, so a resolver that answers public to the guard and private to the connect (DNS rebinding) would walk past it.
// Here the connect's `lookup` is ours: it hands back the vetted addresses and never asks DNS. The URL keeps its host
// name, so the Host header and the TLS server name (SNI and certificate check) are the page's own.

const NO_BODY = new Set([204, 205, 304])

/** `node:http(s)` request to `url`, connected to one of `addresses`, as a web `Response`. Redirects are not followed. */
export function pinnedFetch(url: string, init: RequestInit, addresses: string[]): Promise<Response> {
  const target = new URL(url)
  const request = target.protocol === 'https:' ? httpsRequest : httpRequest
  const family = (address: string) => (address.includes(':') ? 6 : 4)
  return new Promise<Response>((resolve, reject) => {
    // The decoders are the real path. A compression bomb is bounded by the reader, not here: whoever reads stops at its cap
    // on the *decoded* bytes and cancels, which destroys the pipeline and the socket.
    const headers: Record<string, string> = { 'accept-encoding': 'gzip, br, deflate' }
    new Headers(init.headers).forEach((value, key) => {
      headers[key] = value
    })
    const req = request(
      target,
      {
        method: init.method ?? 'GET',
        headers,
        agent: false, // one connection per request: nothing pooled across hosts or pins
        signal: init.signal ?? undefined,
        lookup: ((_host: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
          if (options?.all)
            callback(
              null,
              addresses.map((address) => ({ address, family: family(address) })),
            )
          else callback(null, addresses[0], family(addresses[0]!))
        }) as never,
      },
      (res) => {
        // Anything that goes wrong turning this into a Response must reject the promise and free the socket, not
        // escape as an uncaught exception from an event callback.
        try {
          resolve(toResponse(res))
        } catch (error) {
          res.destroy()
          reject(error)
        }
      },
    )
    req.on('error', reject)
    req.end()
  })
}

/** Content-Encodings decoded here; a stack of them, or any other, is refused rather than handed on undecoded. */
const DECODERS = {
  gzip: createGunzip,
  'x-gzip': createGunzip,
  br: createBrotliDecompress,
  deflate: createInflate,
} as const

function toResponse(res: IncomingMessage): Response {
  const status = res.statusCode ?? 0
  if (status < 200 || status > 599) throw new Error(`unsupported HTTP status ${status}`)
  const headers = new Headers()
  for (const [key, value] of Object.entries(res.headers)) {
    for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value]) headers.append(key, v)
  }
  // Only a body that will be read is decoded, and only there can an encoding be unsupported: a redirect or an error
  // status with a `zstd` body still redirects or fails with its own status (the caller cancels such a body unread).
  const ok = status >= 200 && status < 300
  const encoding = (headers.get('content-encoding') ?? 'identity').trim().toLowerCase()
  if (NO_BODY.has(status)) {
    res.destroy() // no body is coming: do not leave the socket open
    return new Response(null, { status, statusText: res.statusMessage ?? '', headers })
  }
  if (ok && encoding !== 'identity' && encoding !== '' && !Object.hasOwn(DECODERS, encoding)) {
    throw new Error(`unsupported content-encoding "${encoding.slice(0, 40)}"`)
  }
  let source: Readable = res
  if (ok && encoding in DECODERS) {
    headers.delete('content-encoding')
    headers.delete('content-length')
    const decoder = DECODERS[encoding as keyof typeof DECODERS]()
    // `pipeline` destroys both ends when either fails or is cancelled: no socket outlives a dead decoder.
    pipeline(res, decoder, () => undefined)
    source = decoder
  }
  return new Response(Readable.toWeb(source) as unknown as ReadableStream, {
    status,
    statusText: res.statusMessage ?? '',
    headers,
  })
}
