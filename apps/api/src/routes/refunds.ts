import type { FastifyInstance, FastifyRequest } from "fastify";
import { toFils } from "@filspay/money";
import { requireMerchantAuth, requireMerchantRole, requireMerchantWriterActor } from "../auth/requireMerchantAuth.js";
import { UUID_RE } from "../admin/merchants.js";
import { BadRequestError } from "../lib/errors.js";
import { assertRefundRequestScope, initiateMerchantRefund } from "../refunds/initiateMerchantRefund.js";

interface RefundBody {
  transactionId?: unknown;
  amountFils?: unknown;
  reason?: unknown;
}

interface MerchantIdParams {
  merchantId: string;
}

const MAX_REASON_LENGTH = 200;

/** Same rule as routes/transactions.ts: header required, no server-generated fallback. */
function getIdempotencyKey(request: FastifyRequest): string {
  const header = request.headers["idempotency-key"];
  const key = Array.isArray(header) ? header[0] : header;
  if (!key) {
    throw new BadRequestError("idempotency_key_required", "Idempotency-Key header is required");
  }
  return key;
}

function parseRefundBody(body: RefundBody | undefined) {
  const { transactionId, amountFils, reason } = body ?? {};
  if (typeof transactionId !== "string" || !UUID_RE.test(transactionId)) {
    throw new BadRequestError("invalid_request", "transactionId is required and must be a transaction id");
  }
  let amount;
  if (amountFils !== undefined && amountFils !== null) {
    // A non-integer or non-positive amount never reaches the money code as a
    // RangeError (500); it is a plain 400.
    if (typeof amountFils !== "number" || !Number.isSafeInteger(amountFils) || amountFils <= 0) {
      throw new BadRequestError("invalid_amount", "amountFils, if given, must be a positive integer number of fils");
    }
    amount = toFils(amountFils);
  }
  if (reason !== undefined && reason !== null) {
    if (typeof reason !== "string" || reason.length > MAX_REASON_LENGTH) {
      throw new BadRequestError("invalid_reason", `reason, if given, must be a string of at most ${MAX_REASON_LENGTH} characters`);
    }
  }
  return { transactionId, amountFils: amount, reason: typeof reason === "string" ? reason : undefined };
}

const REFUND_ROLES = requireMerchantRole("owner", "finance");

/**
 * `POST /v1/refunds`: the merchant is always the authenticated one, taken
 * from the session or API key, never from the body.
 */
export async function refundRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: RefundBody }>(
    "/",
    { preHandler: [requireMerchantAuth, REFUND_ROLES] },
    async (request, reply) => {
      const auth = request.merchantAuth!;
      const idempotencyKey = getIdempotencyKey(request);
      const parsed = parseRefundBody(request.body);
      const result = await initiateMerchantRefund(app.db, app.acquirer, {
        merchantId: auth.merchantId,
        transactionId: parsed.transactionId,
        amountFils: parsed.amountFils,
        reason: parsed.reason,
        idempotencyKey,
        actor: requireMerchantWriterActor(auth),
      });
      reply.code(result.statusCode).send(result.body);
    },
  );
}

/** `POST /v1/merchants/:merchantId/refunds`: the path the dashboard's refund drawer calls. */
export async function refundMerchantRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: MerchantIdParams; Body: RefundBody }>(
    "/:merchantId/refunds",
    { preHandler: [requireMerchantAuth, REFUND_ROLES] },
    async (request, reply) => {
      const auth = request.merchantAuth!;
      assertRefundRequestScope(auth, request.params.merchantId);
      const idempotencyKey = getIdempotencyKey(request);
      const parsed = parseRefundBody(request.body);
      const result = await initiateMerchantRefund(app.db, app.acquirer, {
        merchantId: request.params.merchantId,
        transactionId: parsed.transactionId,
        amountFils: parsed.amountFils,
        reason: parsed.reason,
        idempotencyKey,
        actor: requireMerchantWriterActor(auth),
      });
      reply.code(result.statusCode).send(result.body);
    },
  );
}
