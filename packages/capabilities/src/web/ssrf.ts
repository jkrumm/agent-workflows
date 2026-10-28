import { type Pin, refused, type ResolvedWebDeps } from './deps.ts'

// The guard behind web.fetch (behaviour of research-gateway's lib/ssrf.ts, rewritten): scheme, hostname literals,
// then every address the name resolves to. It runs on the first URL and again on every redirect hop, and returns the
// vetted addresses: the caller connects to those (`pinned.ts`), so the name is resolved once and a resolver that changes
// its answer afterwards (DNS rebinding) reaches nothing.

const BLOCKED_HOSTNAMES = new Set(['localhost', 'metadata', 'ip6-localhost', 'instance-data'])
// `.ts.net` is the tailnet's MagicDNS: it resolves to 100.64.0.0/10, but the name alone is reason enough to refuse.
const BLOCKED_SUFFIXES = ['.local', '.internal', '.localdomain', '.localhost', '.ts.net', '.lan', '.home.arpa']

const normalizeHostname = (hostname: string) =>
  hostname
    .replace(/^\[|\]$/g, '')
    .toLowerCase()
    .replace(/\.+$/, '')

function parseIpv4(value: string): number[] | undefined {
  const parts = value.split('.')
  if (parts.length !== 4) return undefined
  const octets = parts.map(Number)
  return octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255) ? undefined : octets
}

/** Loopback, private, CGNAT (the tailnet), link-local (cloud metadata), benchmarking, TEST-NETs, multicast, reserved. */
function isPrivateIpv4([a, b, c]: number[]): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b! >= 64 && b! <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a! >= 224
  )
}

function parseIpv6Words(address: string): number[] | undefined {
  let text = address.toLowerCase()
  const dotted = text.match(/(^|:)(\d+\.\d+\.\d+\.\d+)$/)
  if (dotted) {
    const bytes = parseIpv4(dotted[2]!)
    if (!bytes) return undefined
    const tail = `${((bytes[0]! << 8) | bytes[1]!).toString(16)}:${((bytes[2]! << 8) | bytes[3]!).toString(16)}`
    text = `${text.slice(0, dotted.index! + dotted[1]!.length)}${tail}`
  }
  if (text.split('::').length > 2) return undefined
  const [leftText, rightText] = text.split('::')
  const word = (w: string) => (/^[0-9a-f]{1,4}$/.test(w) ? Number.parseInt(w, 16) : undefined)
  const left = leftText ? leftText.split(':').map(word) : []
  const right = rightText ? rightText.split(':').map(word) : []
  if ([...left, ...right].some((w) => w === undefined)) return undefined
  const missing = 8 - left.length - right.length
  if (text.includes('::') ? missing < 1 : missing !== 0) return undefined
  return [...left, ...Array.from({ length: missing }, () => 0), ...right] as number[]
}

const v4Of = (high: number, low: number) => [high >>> 8, high & 0xff, low >>> 8, low & 0xff]

function isPrivateIpv6(address: string): boolean {
  const w = parseIpv6Words(address)
  if (!w) return true // unparseable: fail closed
  const zeros = (n: number) => w.slice(0, n).every((x) => x === 0)
  // IPv4 embedded in IPv6: compatible, mapped, translated, NAT64 (both prefixes). The IPv4 table decides.
  if (
    zeros(6) ||
    (zeros(5) && w[5] === 0xffff) ||
    (zeros(4) && w[4] === 0xffff && w[5] === 0) ||
    (w[0] === 0x64 && w[1] === 0xff9b && (w[2] === 1 || w.slice(2, 6).every((x) => x === 0)))
  ) {
    return isPrivateIpv4(v4Of(w[6]!, w[7]!))
  }
  // Only global unicast 2000::/3 is public; loopback, link-local, ULA, multicast and the rest fail closed.
  if (w[0]! < 0x2000 || w[0]! > 0x3fff) return true
  if (w[0] === 0x2001 && w[1] === 0x0db8) return true // documentation
  if (w[0] === 0x2002) return isPrivateIpv4(v4Of(w[1]!, w[2]!)) // 6to4 carries an IPv4 destination
  return false
}

/** True for an address that is not a public destination. Exported for tests. */
export function isPrivateAddress(address: string): boolean {
  const unscoped = address.split('%', 1)[0]!
  const v4 = parseIpv4(unscoped)
  return v4 ? isPrivateIpv4(v4) : isPrivateIpv6(unscoped)
}

/** Throws `URL_REFUSED` unless `raw` is an http(s) URL whose host is a public name or address. Returns the vetted addresses to connect to. */
export async function assertPublicUrl(deps: ResolvedWebDeps, capability: string, raw: string): Promise<Pin> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw refused(capability, 'not a valid URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw refused(capability, `scheme ${url.protocol} is not http(s)`)
  if (url.username || url.password) throw refused(capability, 'URLs with credentials are not fetched')
  const host = normalizeHostname(url.hostname)
  if (host === '' || BLOCKED_HOSTNAMES.has(host) || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) {
    throw refused(capability, `host ${host || '(empty)'} is internal`)
  }
  let addresses: string[]
  try {
    addresses = await deps.resolve(host)
  } catch {
    throw refused(capability, `host ${host} did not resolve`)
  }
  if (addresses.length === 0) throw refused(capability, `host ${host} did not resolve`)
  const bad = addresses.find(isPrivateAddress)
  if (bad !== undefined) throw refused(capability, `host ${host} resolves to a private or reserved address`)
  return { addresses }
}
