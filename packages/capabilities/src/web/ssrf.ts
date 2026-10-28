import { fail } from '../errors.ts'
import { type Pin, type ResolvedWebDeps, refused } from './deps.ts'

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
  // Digits only: `Number` would also take "", " 1", "0x7f" and "1e1".
  if (parts.some((part) => !/^\d{1,3}$/.test(part))) return undefined
  const octets = parts.map(Number)
  return octets.some((o) => o > 255) ? undefined : octets
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

/** The name did not resolve to any address: not a policy refusal, the caller's chain may go on without a direct read. */
export class HostUnresolved extends Error {}

function isPrivateIpv6(address: string): boolean {
  const w = parseIpv6Words(address)
  if (!w) return true // unparseable: fail closed
  const zeros = (n: number) => w.slice(0, n).every((x) => x === 0)
  // IPv4 embedded in IPv6: compatible, mapped, translated, NAT64 (both prefixes). The IPv4 table decides.
  if (w[0] === 0x64 && w[1] === 0xff9b && w[2] === 1) return true // 64:ff9b:1::/48, NAT64 local-use: no public destination
  if (
    zeros(6) ||
    (zeros(5) && w[5] === 0xffff) ||
    (zeros(4) && w[4] === 0xffff && w[5] === 0) ||
    (w[0] === 0x64 && w[1] === 0xff9b && w.slice(2, 6).every((x) => x === 0))
  ) {
    return isPrivateIpv4(v4Of(w[6]!, w[7]!))
  }
  // Only global unicast 2000::/3 is public; loopback, link-local, ULA, multicast and the rest fail closed.
  if (w[0]! < 0x2000 || w[0]! > 0x3fff) return true
  if (w[0] === 0x2001 && w[1] === 0x0db8) return true // documentation
  // 2001::/23 is the IETF protocol-assignments block, not globally reachable by default (Teredo, benchmarking,
  // deprecated ORCHID inside it); the registry lists the exceptions that are (iana-ipv6-special-registry, read
  // 2026-10-28): 2001:1::1-3 (PCP, TURN, SRP anycast), 2001:3::/32 (AMT), 2001:4:112::/48 (AS112-v6), 2001:20::/28
  // (ORCHIDv2) and 2001:30::/28 (drone remote ID).
  if (w[0] === 0x2001 && w[1]! < 0x200) {
    const anycast = w[1] === 1 && w.slice(2, 7).every((x) => x === 0) && w[7]! >= 1 && w[7]! <= 3
    const global =
      anycast || w[1] === 3 || (w[1] === 4 && w[2] === 0x112) || (w[1]! & 0xfff0) === 0x20 || (w[1]! & 0xfff0) === 0x30
    return !global
  }
  // The AS112 direct-delegation anycast prefix is globally reachable, but nothing a page fetch should be sent to.
  if (w[0] === 0x2620 && w[1] === 0x4f && w[2] === 0x8000) return true
  if (w[0] === 0x3fff && (w[1]! & 0xf000) === 0) return true // 3fff::/20, documentation
  if (w[0] === 0x2002) return isPrivateIpv4(v4Of(w[1]!, w[2]!)) // 6to4 carries an IPv4 destination
  return false
}

/** True for an address that is not a public destination. Exported for tests. */
export function isPrivateAddress(address: string): boolean {
  const unscoped = address.split('%', 1)[0]!
  const v4 = parseIpv4(unscoped)
  return v4 ? isPrivateIpv4(v4) : isPrivateIpv6(unscoped)
}

/**
 * Throws `URL_REFUSED` unless `raw` is an http(s) URL whose host is a public name or address (a policy refusal only);
 * `HostUnresolved` when the name does not resolve. Returns the vetted addresses to connect to.
 */
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
  } catch (error) {
    // Only an authoritative "no such host / no address" lets the chain go on. A resolver that is down or timing out
    // (EAI_AGAIN, ...) says nothing about the URL, which must not be handed to a third party on that basis.
    const code = (error as { code?: unknown }).code
    if (code === 'ENOTFOUND' || code === 'ENODATA') throw new HostUnresolved(`host ${host} did not resolve`)
    throw fail(
      'UPSTREAM_ERROR',
      `${capability}: DNS lookup for ${host} failed${typeof code === 'string' ? ` (${code})` : ''}`,
      {},
    )
  }
  if (addresses.length === 0) throw new HostUnresolved(`host ${host} did not resolve`)
  const bad = addresses.find(isPrivateAddress)
  if (bad !== undefined) throw refused(capability, `host ${host} resolves to a private or reserved address`)
  return { addresses }
}
