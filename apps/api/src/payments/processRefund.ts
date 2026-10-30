import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { ZERO_FILS, addFils, calculateRefundFee, compareFils, subtractFils, toFils, type Fils } from "@filspay/money";
import { enqueueEvent } from "@filspay/events";
import { withTransaction } from "../db/withTransaction.js";
import type { AcquirerSimulator } from "../acquirer/types.js";
import { claimIdempotencyKey, completeIdempotencyKey, failIdempotencyKey, hashRequest } from "./idempotency.js";
import { recordTransactionEvent } from "../transactions/events.js";
import { nextStatusAfterRefund } from "./refundState.js";
import { validateRefundRequest } from "./refundValidation.js";
import { ConflictError, UnprocessableEntityError } from "../lib/errors.js";

const ENDPOINT = "refunds.create";

export interface ProcessRefundInput {
  transactionId: string;
  merchantId: string;
  amountFils?: Fils;
  idempotencyKey: string;
  actor: { type: "merchant_session" | "merchant_api_key"; id: string };
  reason?: string;
}

export interface ProcessRefundResult {
  statusCode: number;
  body: unknown;
}

interface RefundTransactionRow {
  id: string;
  merchant_id: string;
  status: string;
  amount_fils: string | number;
  captured_fils: string | number;
  refunded_fils: string | number;
  acquirer_reference: string;
}

/**
 * Refund business logic, as ONE transaction in the same shape as capture:
 * claim the idempotency key, lock the transaction row (scoped to the calling
 * merchant), validate, call the acquirer, journal the reversal.
 *
 * The row lock is taken before any validation and held through the acquirer
 * call, so two concurrent refunds of the same transaction serialize: the
 * second one re-reads refunded_fils after the first has committed and is
 * refused if nothing is left to return. (Validating in one transaction and
 * journaling in another let both pass the same check and both pay out.)
 *
 * The ceiling is what was CAPTURED minus what was already refunded, never
 * the authorized amount.
 */
export async function processRefund(
  pool: Pool,
  acquirer: AcquirerSimulator,
  input: ProcessRefundInput,
): Promise<ProcessRefundResult> {
  const requestHash = hashRequest({
    transactionId: input.transactionId,
    amountFils: input.amountFils ?? null,
    reason: input.reason ?? null,
  });

  return withTransaction(pool, async (client) => {
    const claim = await claimIdempotencyKey(client, {
      merchantId: input.merchantId,
      endpoint: ENDPOINT,
      key: input.idempotencyKey,
      requestHash,
    });
    if (claim.outcome === "conflict_hash_mismatch") {
      throw new UnprocessableEntityError("idempotency_key_reused");
    }
    if (claim.outcome === "conflict_in_progress") {
      throw new ConflictError("request_in_progress");
    }
    if (claim.outcome === "replay") {
      return { statusCode: claim.row.responseStatusCode ?? 200, body: claim.row.responseBody };
    }

    // Lock first, scoped to the caller's merchant: another merchant's
    // transaction id is indistinguishable from one that does not exist.
    const txnResult = await client.query<RefundTransactionRow>(
      `SELECT id, merchant_id, status, amount_fils, captured_fils, refunded_fils, acquirer_reference
         FROM transactions
        WHERE id = $1 AND merchant_id = $2
        FOR UPDATE`,
      [input.transactionId, input.merchantId],
    );
    const txn = txnResult.rows[0];
    if (!txn) {
      const body = { error: "transaction_not_found" };
      await completeIdempotencyKey(client, claim.row.id, { statusCode: 404, body });
      return { statusCode: 404, body };
    }

    const amountAuthorized = toFils(Number(txn.amount_fils));
    const capturedFils = toFils(Number(txn.captured_fils));
    const refundedFils = toFils(Number(txn.refunded_fils));
    const refundableFils = subtractFils(capturedFils, refundedFils);

    const validation = validateRefundRequest(
      { id: txn.id, merchantId: txn.merchant_id, status: txn.status, capturedFils, refundableFils },
      input.amountFils,
    );
    if (!validation.ok) {
      const statusCode = validation.code === "transaction_not_refundable" ? 409 : 422;
      await completeIdempotencyKey(client, claim.row.id, { statusCode, body: validation });
      return { statusCode, body: validation };
    }
    const requestedAmount = validation.amountFils;

    // The fee actually charged at capture time (gross MDR minus any
    // negotiated discount adjustment), read from the ledger, not recomputed
    // from today's rate. Only the capture's own legs count: earlier refunds'
    // fee-reversal legs touch the same account and must not be netted in.
    const feeResult = await client.query<{ fee_fils: string; reversed_fils: string }>(
      `SELECT
         (SELECT COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_fils ELSE -amount_fils END), 0)
            FROM ledger_entries
           WHERE transaction_id = $1 AND account_id = 'platform_fee_revenue'
             AND description LIKE 'capture:%')::text AS fee_fils,
         (SELECT COALESCE(SUM(fee_reversed_fils), 0)
            FROM refunds WHERE transaction_id = $1 AND status = 'succeeded')::text AS reversed_fils`,
      [txn.id],
    );
    const feeRow = feeResult.rows[0]!;
    const feeChargedFils = toFils(Math.max(0, Number(feeRow.fee_fils)));
    const alreadyReversedFils = toFils(Number(feeRow.reversed_fils));

    const acquirerResult = await acquirer.refund({
      acquirerReference: txn.acquirer_reference,
      amountFils: requestedAmount,
      idempotencyKey: `${claim.row.id}:${claim.row.attemptCount}`,
    });
    if (acquirerResult.outcome === "declined") {
      const body = { error: "refund_declined" };
      await completeIdempotencyKey(client, claim.row.id, { statusCode: 402, body });
      return { statusCode: 402, body };
    }
    if (acquirerResult.outcome === "error") {
      const body = { error: "acquirer_unavailable" };
      await failIdempotencyKey(client, claim.row.id, { statusCode: 502, body });
      return { statusCode: 502, body };
    }

    const newRefundedTotal = addFils(refundedFils, requestedAmount);
    const newStatus = nextStatusAfterRefund({
      amountFils: amountAuthorized,
      capturedFils,
      refundedTotalFils: newRefundedTotal,
    });

    // Cumulative: the fee owed back after this refund is the fee's share for
    // everything refunded so far, minus what earlier refunds already gave
    // back. Several partials therefore add up to exactly the original fee.
    const cumulativeReversal = calculateRefundFee(capturedFils, feeChargedFils, newRefundedTotal);
    const feeReversedFils = toFils(
      Math.min(Math.max(0, cumulativeReversal - alreadyReversedFils), feeChargedFils - alreadyReversedFils),
    );

    const refundResult = await client.query<{ id: string; occurred_at: Date }>(
      `INSERT INTO refunds
         (transaction_id, merchant_id, amount_fils, fee_reversed_fils, status,
          acquirer_reference, reason, created_by_type, created_by_id)
       VALUES ($1, $2, $3, $4, 'succeeded', $5, $6, $7, $8)
       RETURNING id, occurred_at`,
      [
        txn.id,
        txn.merchant_id,
        requestedAmount,
        feeReversedFils,
        acquirerResult.acquirerReference,
        // refunds.reason is NOT NULL (0070); an explicit NULL does not pick up the column default.
        input.reason?.trim() || "unspecified",
        input.actor.type,
        input.actor.id,
      ],
    );
    const refund = refundResult.rows[0];
    if (!refund) {
      throw new Error("processRefund: insert into refunds returned no row");
    }

    await client.query(`UPDATE transactions SET refunded_fils = $2, status = $3 WHERE id = $1`, [
      txn.id,
      newRefundedTotal,
      newStatus,
    ]);
    if (newStatus === "refunded") {
      await client.query(`UPDATE holds SET status = 'released' WHERE transaction_id = $1 AND status = 'active'`, [
        txn.id,
      ]);
    }

    // Double-entry reversal, mirroring capture's legs with the directions
    // swapped. ledger_entries has CHECK (amount_fils > 0), so a reversal
    // flips direction and never the sign.
    const entryGroupId = randomUUID();
    await client.query(
      `INSERT INTO ledger_entries
         (entry_group_id, merchant_id, transaction_id, account_id, direction, amount_fils, occurred_at, description)
       VALUES
         ($1, $2, $3, 'merchant_payable',     'debit',  $4, now(), 'refund: gross'),
         ($1, $2, $3, 'card_scheme_clearing', 'credit', $4, now(), 'refund: gross')`,
      [entryGroupId, txn.merchant_id, txn.id, requestedAmount],
    );
    if (compareFils(feeReversedFils, ZERO_FILS) > 0) {
      await client.query(
        `INSERT INTO ledger_entries
           (entry_group_id, merchant_id, transaction_id, account_id, direction, amount_fils, occurred_at, description)
         VALUES
           ($1, $2, $3, 'platform_fee_revenue', 'debit',  $4, now(), 'refund: MDR fee reversal'),
           ($1, $2, $3, 'merchant_payable',     'credit', $4, now(), 'refund: MDR fee reversal')`,
        [entryGroupId, txn.merchant_id, txn.id, feeReversedFils],
      );
    }

    // The timeline records what this refund did to the captured amount.
    const eventType = compareFils(newRefundedTotal, capturedFils) >= 0 ? "refunded" : "refund_partial";
    await recordTransactionEvent(client, {
      transactionId: txn.id,
      eventType,
      amountFils: toFils(-requestedAmount, { allowNegative: true }),
      actor: input.actor,
      metadata: {
        refundId: refund.id,
        feeReversedFils,
        acquirerReference: acquirerResult.acquirerReference,
      },
    });
    await enqueueEvent(client, {
      eventType: "refund.succeeded",
      aggregateType: "transaction",
      aggregateId: txn.id,
      payload: {
        merchantId: txn.merchant_id,
        refundId: refund.id,
        amountFils: requestedAmount,
        feeReversedFils,
        refundedTotalFils: newRefundedTotal,
        newStatus,
      },
    });

    const body = {
      id: refund.id,
      transactionId: txn.id,
      merchantId: txn.merchant_id,
      amountFils: requestedAmount,
      feeReversedFils,
      status: "succeeded",
      transactionStatus: newStatus,
      refundedTotalFils: newRefundedTotal,
      acquirerReference: acquirerResult.acquirerReference,
      occurredAt: refund.occurred_at.toISOString(),
    };
    await completeIdempotencyKey(client, claim.row.id, { statusCode: 200, body, resourceId: refund.id });
    return { statusCode: 200, body };
  });
}
