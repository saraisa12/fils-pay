import { createHmac } from "node:crypto";
import { timingSafeEqualHex } from "../lib/crypto.js";

/** Verifies the signature on an inbound acquirer callback. */

interface ParsedAcquirerSignatureHeader {
  timestamp: number;
  signature: string;
}

function parseAcquirerSignatureHeader(header: string): ParsedAcquirerSignatureHeader | null {
  let timestampStr: string | null = null;
  let signature: string | null = null;

  for (const part of header.split(",")) {
    const eqIndex = part.indexOf("=");
    if (eqIndex === -1) continue;
    const key = part.slice(0, eqIndex).trim();
    const value = part.slice(eqIndex + 1).trim();
    if (key === "t") timestampStr = value;
    else if (key === "v1") signature = value;
  }

  if (!timestampStr || !signature) return null;
  if (!/^\d+$/.test(timestampStr)) return null;

  const timestamp = Number.parseInt(timestampStr, 10);
  if (!Number.isFinite(timestamp)) return null;

  return { timestamp, signature };
}

export type VerifyAcquirerCallbackFailureReason = "malformed_header" | "signature_mismatch" | "timestamp_out_of_tolerance";

export interface VerifyAcquirerCallbackResult {
  valid: boolean;
  reason?: VerifyAcquirerCallbackFailureReason;
}

export interface VerifyAcquirerCallbackOptions {
  /** Max |now - t| in seconds; replays of an old genuine callback are refused. Default 300. */
  toleranceSeconds?: number;
  /** Unix seconds, injectable for tests. */
  now?: number;
}

/**
 * Verifies the signature on an inbound acquirer callback.
 *
 * `payload` should be the RAW request body string: the HMAC is over `${t}.${rawBody}`, the exact bytes
 * the acquirer sent. Re-serializing a parsed object (JSON.stringify) can change key order or spacing
 * and reject genuine callbacks, or accept a body that is not the one that was signed. An object is
 * still accepted and serialized for callers that only have the parsed form.
 *
 * With a header present the secret must be non-empty (an HMAC keyed with "" is something anyone can
 * compute), the comparison is constant-time, and the timestamp must be fresh.
 */
export function verifyAcquirerCallbackSignature(
  payload: unknown,
  header: string | undefined,
  secret: string,
  requireSignature = false,
  options: VerifyAcquirerCallbackOptions = {},
): VerifyAcquirerCallbackResult {
  if (!header) {
    return requireSignature
      ? { valid: false, reason: "malformed_header" }
      : { valid: true };
  }

  const parsed = parseAcquirerSignatureHeader(header);
  if (!parsed) return { valid: false, reason: "malformed_header" };

  if (secret === "") return { valid: false, reason: "signature_mismatch" };

  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  const expected = createHmac("sha256", secret).update(`${parsed.timestamp}.${body}`).digest("hex");

  if (!timingSafeEqualHex(expected, parsed.signature)) {
    return { valid: false, reason: "signature_mismatch" };
  }

  const now = options.now ?? Math.floor(Date.now() / 1000);
  const tolerance = options.toleranceSeconds ?? 300;
  if (Math.abs(now - parsed.timestamp) > tolerance) {
    return { valid: false, reason: "timestamp_out_of_tolerance" };
  }

  return { valid: true };
}
