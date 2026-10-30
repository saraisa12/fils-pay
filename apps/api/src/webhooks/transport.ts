/**
 * The injectable HTTP send — `runDispatchPass` and everything it calls take
 * a `WebhookTransport` as an explicit parameter, never calling `fetch`
 * directly deep inside dispatch logic. Same "pass the effectful dependency
 * in" shape as `AcquirerSimulator`.
 */

/**
 * @property timeoutMs Covers the whole exchange including reading the body (the abort
 * signal stays armed until the body has been read).
 */
import { assertPublicHost } from "./ssrf.js";

export interface WebhookTransportRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
}

export interface WebhookTransportResponse {
  /** null on a transport-level failure (timeout, DNS, connection refused —
   *  never reached the receiver) */
  statusCode: number | null;
  /** "" on a transport-level failure */
  body: string;
  /** present iff statusCode is null */
  errorMessage?: string;
}

export type WebhookTransport = (req: WebhookTransportRequest) => Promise<WebhookTransportResponse>;

/** Real transport: Node's global fetch with an AbortController-driven
 *  timeout, used by index.ts's production wiring. */
export interface FetchTransportOptions {
  /** Refuse destinations that resolve to loopback/private/link-local addresses (production). */
  blockPrivateAddresses?: boolean;
  /** Stop reading a response after this many bytes. Default 64 KiB: we only keep a 2 KB excerpt. */
  maxResponseBytes?: number;
}

/** Reads at most `maxBytes` of the body, then cancels the rest, so a hostile receiver cannot make us
 *  buffer a huge (or endless) response. */
async function readCapped(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
    if (total >= maxBytes) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  return Buffer.concat(chunks).subarray(0, maxBytes).toString("utf8");
}

export function createFetchTransport(options: FetchTransportOptions = {}): WebhookTransport {
  const maxResponseBytes = options.maxResponseBytes ?? 65_536;
  return async (req: WebhookTransportRequest): Promise<WebhookTransportResponse> => {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), req.timeoutMs);
    try {
      // Checked on every attempt, after DNS, so a hostname that was public when the endpoint was
      // saved but points inside now is still refused.
      if (options.blockPrivateAddresses) {
        await assertPublicHost(new URL(req.url).hostname);
      }
      const response = await fetch(req.url, {
        method: "POST",
        headers: req.headers,
        body: req.body,
        signal: controller.signal,
        // A 3xx from the receiver must not walk us to an internal address the URL check never saw.
        // It is reported like any other non-2xx answer and the delivery is retried.
        redirect: "manual",
      });
      const body = await readCapped(response, maxResponseBytes);
      return { statusCode: response.status, body };
    } catch (err) {
      return {
        statusCode: null,
        body: "",
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    } finally {
      clearTimeout(timeoutHandle);
    }
  };
}
