import fp from "fastify-plugin";
import type { FastifyRequest } from "fastify";

/**
 * Load shedding for the money-moving routes.
 *
 * authorize and capture each hold a database connection while they call the acquirer, so the number of
 * checkouts in flight is bounded by the connection pool. Past that point extra requests do not get faster
 * service, they just queue (measured: 400 simultaneous clients on a pool of 20 gave a 10 s median wait),
 * and a real client gives up and retries, which makes it worse. So above `maxInflight` we answer at once
 * with `503` and `Retry-After`, before any work or any database access, which is always safe to retry
 * (nothing happened). Reads, login, health checks and everything else are never shed.
 */
const SHED_ROUTES = new Set([
  "POST /v1/payment-links/:token/pay",
  "POST /v1/transactions",
  "POST /v1/transactions/:id/capture",
  "POST /v1/transactions/:id/void",
  "POST /v1/merchants/:merchantId/refunds",
  "POST /v1/refunds",
]);

export interface LoadSheddingOptions {
  /** Maximum money-moving requests being handled at once. 0 disables shedding. */
  maxInflight: number;
}

export const loadSheddingPlugin = fp<LoadSheddingOptions>(async (app, opts) => {
  let inflight = 0;
  const counted = new WeakSet<FastifyRequest>();

  app.decorate("inflightPayments", () => inflight);

  app.addHook("onRequest", async (request, reply) => {
    if (opts.maxInflight <= 0) return;
    if (!SHED_ROUTES.has(`${request.method} ${request.routeOptions.url}`)) return;
    if (inflight >= opts.maxInflight) {
      reply
        .header("Retry-After", "1")
        .code(503)
        .send({ error: "overloaded", message: "The server is busy. Retry in a moment." });
      return reply;
    }
    inflight += 1;
    counted.add(request);
  });

  // Released exactly once, whether the request finishes normally or the client disconnects first.
  const release = async (request: FastifyRequest): Promise<void> => {
    if (counted.delete(request)) inflight -= 1;
  };
  app.addHook("onResponse", release);
  app.addHook("onRequestAbort", release);
});

declare module "fastify" {
  interface FastifyInstance {
    /** Money-moving requests currently being handled (for tests and diagnostics). */
    inflightPayments: () => number;
  }
}
