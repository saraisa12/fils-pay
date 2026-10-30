/**
 * SSRF guard for outbound webhook calls. A merchant chooses the URL we POST to, and "https only" does
 * not stop https://localhost/, https://169.254.169.254/ (cloud metadata) or https://settlement:8091/
 * (our own internal API, which is on the same network). In production the destination must be a public
 * address, checked both when the URL is saved (literal hosts) and when it is called (after DNS
 * resolution, so a name that points inside is caught too).
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

function ipv4Parts(ip: string): number[] | null {
  const parts = ip.split(".").map(Number);
  return parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? parts : null;
}

/** True for loopback, private, link-local, CGNAT, multicast/reserved and unspecified addresses. */
export function isPrivateAddress(address: string): boolean {
  let ip = address.toLowerCase();
  if (ip.startsWith("[") && ip.endsWith("]")) ip = ip.slice(1, -1);

  const kind = isIP(ip);
  if (kind === 4) {
    const p = ipv4Parts(ip);
    if (!p) return true;
    const [a, b] = p as [number, number, number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) || // CGNAT
      (a === 169 && b === 254) || // link-local, cloud metadata
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) || // IETF protocol assignments / TEST-NET-1
      (a === 198 && (b === 18 || b === 19)) || // benchmarking
      a >= 224 // multicast, reserved, broadcast
    );
  }
  if (kind === 6) {
    if (ip === "::" || ip === "::1") return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip); // IPv4-mapped
    if (mapped) return isPrivateAddress(mapped[1]!);
    const first = Number.parseInt(ip.split(":")[0] || "0", 16);
    return (
      (first & 0xfe00) === 0xfc00 || // fc00::/7 unique local
      (first & 0xffc0) === 0xfe80 || // fe80::/10 link-local
      (first & 0xff00) === 0xff00 // multicast
    );
  }
  return false;
}

/** Names that are internal by construction: localhost, *.localhost/.local/.internal, and single-label hosts. */
export function isInternalHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  return (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    h.endsWith(".local") ||
    h.endsWith(".internal") ||
    (isIP(h.replace(/^\[|\]$/g, "")) === 0 && !h.includes("."))
  );
}

/**
 * Throws unless every address `hostname` resolves to is public. Used by the transport at call time.
 */
export async function assertPublicHost(hostname: string): Promise<void> {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new Error(`webhook destination ${host} is not a public address`);
    return;
  }
  if (isInternalHostname(host)) throw new Error(`webhook destination ${host} is an internal host name`);
  const resolved = await lookup(host, { all: true });
  if (resolved.length === 0 || resolved.some((r) => isPrivateAddress(r.address))) {
    throw new Error(`webhook destination ${host} resolves to a non-public address`);
  }
}
