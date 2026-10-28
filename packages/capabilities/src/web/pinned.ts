import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { Readable } from 'node:stream'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'

// A request that connects to an address the SSRF guard already vetted. `fetch` resolves the name itself at connect
// time, so a resolver that answers public to the guard and private to the connect (DNS rebinding) would walk past it.
// Here the connect's `lookup` is ours: it hands back the vetted addresses and never asks DNS. The URL keeps its host
// name, so the Host header and the TLS server name (SNI and certificate check) are the page's own.

const NO_BODY = new Set([101, 204, 205, 304])

/** `node:http(s)` request to `url`, connected to one of `addresses`, as a web `Response`. Redirects are not followed. */
export function pinnedFetch(url: string, init: RequestInit, addresses: string[]): Promise<Response> {
  const target = new URL(url)
  const request = target.protocol === 'https:' ? httpsRequest : httpRequest
  const family = (address: string) => (address.includes(':') ? 6 : 4)
  return new Promise<Response>((resolve, reject) => {
    const headers: Record<string, string> = { 'accept-encoding': 'identity' }
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
        const responseHeaders = new Headers()
        for (const [key, value] of Object.entries(res.headers)) {
          for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value])
            responseHeaders.append(key, v)
        }
        const encoding = responseHeaders.get('content-encoding')?.toLowerCase()
        const decoder =
          encoding === 'gzip'
            ? createGunzip()
            : encoding === 'br'
              ? createBrotliDecompress()
              : encoding === 'deflate'
                ? createInflate()
                : undefined
        if (decoder) {
          responseHeaders.delete('content-encoding')
          responseHeaders.delete('content-length')
          res.on('error', (error) => decoder.destroy(error))
        }
        const status = res.statusCode ?? 0
        const body = NO_BODY.has(status)
          ? null
          : (Readable.toWeb(decoder ? res.pipe(decoder) : res) as unknown as ReadableStream)
        resolve(new Response(body, { status, statusText: res.statusMessage ?? '', headers: responseHeaders }))
      },
    )
    req.on('error', reject)
    req.end()
  })
}
