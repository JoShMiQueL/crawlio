/**
 * The private/reserved-IP guard behind `FetchHtmlOptions.blockPrivateHosts`.
 *
 * The check has two paths, both cheap: IP literals (what `url.hostname`
 * yields for `http://127.0.0.1` or `http://[::1]`) classify directly, and
 * hostnames resolve through DNS first — a `localhost` or an attacker name
 * pointing at `10.0.0.4` is refused on the ANSWER, not on the string.
 *
 * Honest limit — this is lookup-time gating (TOCTOU): the name is re-resolved
 * at connect time by the runtime's own resolver, which this module cannot
 * see, so a determined host can rebind between the check and the connect.
 * For strict isolation, run crawlio behind an egress firewall or in a
 * network-restricted environment.
 */
import { BlockedHostError, scrubUrl } from "./errors.js";

/**
 * A DNS resolver: hostname → every address it answered. Injectable so tests
 * drive `blockPrivateHosts` deterministically (the `__dnsLookup` seam in
 * fetch.ts/robots.ts).
 */
export type HostLookup = (hostname: string) => Promise<readonly string[]>;

type NodeDnsPromises = typeof import("node:dns/promises");

// Resolved lazily and memoized — `node:dns` is reached through
// `process.getBuiltinModule` (Node >=22.3, Bun) rather than a static import,
// so this module never touches a builtin at load time under a bundler that
// may not provide one (same pattern as src/version.ts).
let dnsPromise: Promise<NodeDnsPromises> | undefined;

function nodeDns(): Promise<NodeDnsPromises> {
  dnsPromise ??= (async () => {
    const builtin =
      typeof process === "undefined" ? undefined : process.getBuiltinModule?.("node:dns");
    return (
      (builtin?.promises as NodeDnsPromises | undefined) ?? (await import("node:dns/promises"))
    );
  })();
  return dnsPromise;
}

/**
 * The system resolver — `dns.promises.lookup` with `all: true`, so EVERY
 * address the hostname answers to is checked (a public A alongside a private
 * AAAA still blocks: the connect could pick either).
 */
export const systemHostLookup: HostLookup = async (hostname) => {
  const dns = await nodeDns();
  const entries = await dns.lookup(hostname, { all: true, verbatim: true });
  return entries.map((entry) => entry.address);
};

/**
 * Parse a canonical dotted-quad IPv4 literal into a 32-bit value; `undefined`
 * when the input is not one. `url.hostname` and DNS answers arrive already
 * canonicalized — non-decimal spellings (`0x7f…`, `127.1`) are normalized by
 * the WHATWG URL parser long before they reach this function.
 */
export function parseIpv4(address: string): number | undefined {
  const parts = address.split(".");
  if (parts.length !== 4) return undefined;
  let value = 0;
  for (const part of parts) {
    if (part === "" || part.length > 3 || !/^\d+$/.test(part)) return undefined;
    const octet = Number(part);
    if (octet > 255) return undefined;
    value = value * 256 + octet;
  }
  return value >>> 0;
}

/** One 16-bit IPv6 group as a hex string; `undefined` when malformed. */
function hexGroup(group: string): number | undefined {
  if (group === "" || group.length > 4 || !/^[0-9a-fA-F]+$/.test(group)) return undefined;
  return Number.parseInt(group, 16);
}

/**
 * Parse an IPv6 literal into a 128-bit value; `undefined` when the input is
 * not one. Handles `::` compression, an `%zone` suffix (`fe80::1%eth0`,
 * kept by URL hostnames as `%25eth0`), and an embedded dotted-quad tail
 * (`::ffff:1.2.3.4` — the IPv4 is counted as the last two groups).
 */
export function parseIpv6(address: string): bigint | undefined {
  let input = address;
  const zone = input.indexOf("%");
  if (zone !== -1) input = input.slice(0, zone);
  // An IPv4 tail contributes two 16-bit groups to the group count.
  const lastColon = input.lastIndexOf(":");
  const tail = lastColon === -1 ? "" : input.slice(lastColon + 1);
  let v4Tail: number | undefined;
  if (tail.includes(".")) {
    v4Tail = parseIpv4(tail);
    if (v4Tail === undefined) return undefined;
    // The dotted quad's preceding colon may BE one half of a `::`
    // compression (`::ffff:1.2.3.4`, `1::1.2.3.4`): slicing at `lastColon`
    // would eat it and split the remainder as an uncompressed address —
    // misparse. Keep that colon so the `::` survives the slice.
    input = input.slice(0, lastColon + (input[lastColon - 1] === ":" ? 1 : 0));
  }
  const halves = input.split("::");
  if (halves.length > 2) return undefined;
  const leftText = halves[0] ?? "";
  const rightText = halves.length === 2 ? halves[1] : undefined;
  const left = leftText === "" ? [] : leftText.split(":");
  const right = rightText === undefined ? undefined : rightText === "" ? [] : rightText.split(":");
  const tailGroups = v4Tail === undefined ? 0 : 2;
  const total = left.length + (right?.length ?? 0) + tailGroups;
  let fill: number;
  if (right === undefined) {
    // No `::` — every group must be written out.
    if (total !== 8) return undefined;
    fill = 0;
  } else {
    // `::` compresses at least one group.
    if (total >= 8) return undefined;
    fill = 8 - total;
  }
  const groups = [...left, ...Array.from({ length: fill }, () => "0"), ...(right ?? [])];
  let value = 0n;
  for (const group of groups) {
    const parsed = hexGroup(group);
    if (parsed === undefined) return undefined;
    value = (value << 16n) | BigInt(parsed);
  }
  // The tail occupies bits 0-31 BELOW the groups already accumulated in
  // bits 0-95 — an OR would corrupt the last two parsed groups.
  if (v4Tail !== undefined) value = (value << 32n) | BigInt(v4Tail >>> 0);
  return value;
}

/** Whether `address` is an IP literal (v4 or v6) at all — else it is a hostname. */
export function isIpLiteral(address: string): boolean {
  return parseIpv4(address) !== undefined || parseIpv6(address) !== undefined;
}

/**
 * IPv4 ranges `blockPrivateHosts` refuses — `[network, prefixBits]` pairs:
 * private, loopback, link-local, CGNAT, benchmarking, documentation,
 * multicast and reserved space. `169.254.169.254` (the cloud metadata
 * endpoint) rides inside 169.254/16; `0.0.0.0` inside 0/8 ("this network").
 *
 * NOT exhaustive — it is a high-value denylist of the ranges an SSRF pivot
 * most often reaches, not a full IANA special-registry mirror. Callers with
 * strict isolation needs still want an egress firewall (see the option
 * docs' TOCTOU caveat).
 */
const PRIVATE_IPV4: ReadonlyArray<readonly [number, number]> = [
  [0x00000000, 8], // 0.0.0.0/8 "this network"
  [0x0a000000, 8], // 10.0.0.0/8 private
  [0x64400000, 10], // 100.64.0.0/10 CGNAT
  [0x7f000000, 8], // 127.0.0.0/8 loopback
  [0xa9fe0000, 16], // 169.254.0.0/16 link-local
  [0xac100000, 12], // 172.16.0.0/12 private
  [0xc0000000, 24], // 192.0.0.0/24 IETF protocol assignments
  [0xc0000200, 24], // 192.0.2.0/24 TEST-NET-1 documentation
  [0xc0a80000, 16], // 192.168.0.0/16 private
  [0xc6120000, 15], // 198.18.0.0/15 benchmarking
  [0xc6336400, 24], // 198.51.100.0/24 TEST-NET-2 documentation
  [0xcb007100, 24], // 203.0.113.0/24 TEST-NET-3 documentation
  [0xe0000000, 4], // 224.0.0.0/4 multicast
  [0xf0000000, 4], // 240.0.0.0/4 reserved (incl. 255.255.255.255)
];

function isPrivateIpv4(value: number): boolean {
  for (const [base, bits] of PRIVATE_IPV4) {
    const shift = 32 - bits;
    if (value >>> shift === base >>> shift) return true;
  }
  return false;
}

/**
 * Whether an IP literal (or one address a hostname resolved to) sits in a
 * range `blockPrivateHosts` refuses. Non-IP input returns `false` — this
 * classifies ADDRESSES, not hostnames; callers resolve names first.
 */
export function isPrivateAddress(address: string): boolean {
  const v4 = parseIpv4(address);
  if (v4 !== undefined) return isPrivateIpv4(v4);
  const v6 = parseIpv6(address);
  if (v6 === undefined) return false;
  // IPv4-embedded forms: `::/96` (the deprecated compatible format — which
  // also covers `::` and `::1`, landing them in 0/8's block) and
  // `::ffff:0:0/96` mapped addresses both carry a 32-bit IPv4 in the low
  // word — classify it by the IPv4 table.
  const high = v6 >> 32n;
  if (high === 0n || high === 0xffffn) {
    return isPrivateIpv4(Number(v6 & 0xffffffffn));
  }
  // 6to4 (2002::/16) embeds its IPv4 in bits 16–48 — same embedded-address
  // problem, same check.
  if (v6 >> 112n === 0x2002n) {
    return isPrivateIpv4(Number((v6 >> 80n) & 0xffffffffn));
  }
  // NAT64 (RFC 6052) — the well-known prefix 64:ff9b::/96 embeds a 32-bit
  // IPv4 in the low word; the translator will dial it, so classify the
  // embedded address. The local-use prefix 64:ff9b:1::/48 (RFC 8215) keeps
  // the same address in bits 64–95 instead, between two zero fields — both
  // must be zero before we trust the placement.
  if (v6 >> 96n === 0x64ff9bn) {
    return isPrivateIpv4(Number(v6 & 0xffffffffn));
  }
  if (v6 >> 80n === 0x64ff9b0001n && ((v6 >> 64n) & 0xffffn) === 0n && (v6 & 0xffffffffn) === 0n) {
    return isPrivateIpv4(Number((v6 >> 32n) & 0xffffffffn));
  }
  if (v6 >> 118n === 0x3fan) return true; // fe80::/10 link-local
  const first8 = v6 >> 120n;
  if ((first8 & 0xfen) === 0xfcn) return true; // fc00::/7 unique-local
  if (first8 === 0xffn) return true; // ff00::/8 multicast
  return false;
}

/**
 * Throw {@link BlockedHostError} when `rawUrl`'s host is a private/reserved
 * IP — a literal directly, a hostname after DNS resolution. Non-http(s) and
 * unparseable URLs pass through: the fetch layer's own gates already refuse
 * or diagnose those, and this guard must not invent new failures for them.
 *
 * Called per redirect hop by `fetchHtmlOnce` (every `Location` target is a
 * fresh hostname that needs its own lookup) and by `fetchRobotsTxtResult`,
 * whose probe fires before the page fetch it gates.
 */
export async function assertPublicHost(
  rawUrl: string,
  lookup: HostLookup = systemHostLookup,
): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
  const hostname = parsed.hostname;
  // URL keeps IPv6 literals bracketed (`[::1]`); strip for classification.
  const literal =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  if (isIpLiteral(literal)) {
    if (isPrivateAddress(literal)) {
      throw new BlockedHostError(
        `Refusing ${scrubUrl(rawUrl)} — ${literal} is a private/reserved address`,
        { url: rawUrl, address: literal },
      );
    }
    // A public IP literal needs no DNS resolution.
    return;
  }
  for (const address of await lookup(hostname)) {
    // Fail CLOSED on resolver garbage: an answer that is no IP literal at
    // all cannot be proven public, and skipping it would let a hostile or
    // broken resolver smuggle the real connect past the guard.
    if (!isIpLiteral(address)) {
      throw new BlockedHostError(
        `Refusing ${scrubUrl(rawUrl)} — ${hostname} resolved to a non-IP answer ${address}`,
        { url: rawUrl, address },
      );
    }
    if (isPrivateAddress(address)) {
      throw new BlockedHostError(
        `Refusing ${scrubUrl(rawUrl)} — ${hostname} resolves to private/reserved address ${address}`,
        { url: rawUrl, address },
      );
    }
  }
}
