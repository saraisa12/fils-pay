import { useState } from "react";
import { parseBhdToFils } from "@filspay/money";
import { request, describeError } from "../../api/client.js";
import { useDashboardAuth } from "../../auth/DashboardAuthContext.js";
import { RequireRole } from "../../auth/RequireRole.js";
import { bhd } from "../../format.js";
import type { TransactionDto } from "../../types.js";

interface RefundResponse {
  id: string;
  transactionId: string;
  amountFils: number;
  feeReversedFils: number;
  status: string;
  transactionStatus: string;
  refundedTotalFils: number;
  occurredAt: string;
}

interface RefundDrawerProps {
  txn: TransactionDto;
  onRefunded: () => Promise<void>;
}

const REFUNDABLE_STATUSES: ReadonlyArray<TransactionDto["status"]> = [
  "captured",
  "partially_captured",
  "partially_refunded",
];

/**
 * Refund control for the transaction page. The amount is typed in BHD (up to
 * three decimals, the same way a merchant reads it on a statement) and sent
 * as whole fils. Left blank, everything still refundable is returned.
 * `POST /v1/merchants/:merchantId/refunds` re-checks the role, the owner and
 * the ceiling server-side; this form only saves a round trip.
 */
export function RefundDrawer({ txn, onRefunded }: RefundDrawerProps) {
  const { me } = useDashboardAuth();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const merchantId = me?.merchant.id;
  const refundableFils = txn.capturedFils - txn.refundedFils;

  if (!REFUNDABLE_STATUSES.includes(txn.status) || refundableFils <= 0) return null;

  async function handleRefund(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!merchantId) return;
    setError(null);

    const trimmed = amount.trim();
    let amountFils: number | undefined;
    if (trimmed !== "") {
      try {
        amountFils = parseBhdToFils(trimmed);
      } catch {
        setError("Enter the amount in BHD with up to three decimals, for example 4.750.");
        return;
      }
      if (amountFils <= 0 || amountFils > refundableFils) {
        setError(`The refund must be between 0.001 and ${bhd(refundableFils)}.`);
        return;
      }
    }

    const shown = amountFils === undefined ? bhd(refundableFils) : bhd(amountFils);
    if (!window.confirm(`Refund ${shown}? The money goes back to the cardholder and cannot be recalled.`)) {
      return;
    }

    setSubmitting(true);
    try {
      const body: Record<string, unknown> = { transactionId: txn.id };
      if (amountFils !== undefined) body.amountFils = amountFils;
      if (reason.trim() !== "") body.reason = reason.trim();

      await request<RefundResponse>(`/v1/merchants/${encodeURIComponent(merchantId)}/refunds`, {
        method: "POST",
        // A fresh key per click, including a retry after a decline, same
        // discipline as capture and the checkout page's submit handler.
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify(body),
      });

      setOpen(false);
      setAmount("");
      setReason("");
      // Refetch rather than patch: the refund wrote a new transaction_events
      // row server-side, so the timeline is stale, not merely shorter.
      await onRefunded();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <RequireRole allow={["owner", "finance"]}>
      <div className="dash-actions">
        {error ? <p className="dash-error">{error}</p> : null}
        {open ? (
          <form className="dash-form dash-form-inline" onSubmit={(e) => void handleRefund(e)}>
            <label>
              Amount in BHD (blank refunds everything still refundable)
              <input
                type="text"
                inputMode="decimal"
                placeholder={bhd(refundableFils).replace(" BHD", "")}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </label>
            <label>
              Reason (optional)
              <input type="text" maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} />
            </label>
            <p className="dash-muted">Still refundable: {bhd(refundableFils)}</p>
            <button type="submit" className="dash-button" disabled={submitting}>
              {submitting ? "Refunding..." : "Refund"}
            </button>
            <button
              type="button"
              className="dash-button"
              disabled={submitting}
              onClick={() => {
                setOpen(false);
                setError(null);
              }}
            >
              Cancel
            </button>
          </form>
        ) : (
          <button type="button" className="dash-button" onClick={() => setOpen(true)}>
            Refund
          </button>
        )}
      </div>
    </RequireRole>
  );
}
