import { useState } from "react";
import { formatBhd, parseBhdToFils } from "@filspay/money";
import { Link, useNavigate } from "react-router-dom";
import { createPaymentLink } from "../../api/paymentLinks.js";
import { describeError } from "../../api/client.js";
import { useDashboardAuth } from "../../auth/DashboardAuthContext.js";
import { localDateTimeToIso } from "../../format.js";

/**
 * `POST /v1/merchants/:merchantId/payment-links`, `owner`/`finance`
 * server-side.
 *
 * Amount is entered in BHD (up to 3 decimals), the unit merchants think in
 * and the one the checkout shows. It is converted with `parseBhdToFils` from
 * @filspay/money (the shared, tested parser), never a second parser here.
 * Before, the field took raw fils, so a merchant typing "20" for 20 BHD
 * created a 0.020 BHD link.
 *
 * The two client-side checks below mirror the server's own two real checks so
 * an obviously-bad value doesn't need a round trip. They are not the
 * validation: `400 invalid_amount` / `400 invalid_expiry` remain the real
 * answer and are rendered verbatim.
 */
/** Shows what the customer will be asked to pay, so a typo is caught before the link exists. */
function amountPreview(raw: string): string {
  try {
    const fils = parseBhdToFils(raw.trim());
    return fils > 0 ? `The customer will pay ${formatBhd(fils)} BHD.` : "Up to three decimals, for example 20 or 4.750.";
  } catch {
    return "Up to three decimals, for example 20 or 4.750.";
  }
}

export function PaymentLinkCreatePage() {
  const { me } = useDashboardAuth();
  const navigate = useNavigate();

  const [amountFils, setAmountFils] = useState("");
  const [reference, setReference] = useState("");
  const [description, setDescription] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!me) return;
    setError(null);

    let amount: number;
    try {
      amount = parseBhdToFils(amountFils.trim());
    } catch {
      setError("Enter the amount in BHD with up to three decimals, for example 20 or 4.750.");
      return;
    }
    if (amount <= 0) {
      setError("The amount must be more than 0.");
      return;
    }
    const expiresAtIso = localDateTimeToIso(expiresAt);
    if (!expiresAtIso) {
      setError("Expiry must be a valid date and time.");
      return;
    }
    if (new Date(expiresAtIso).getTime() <= Date.now()) {
      setError("Expiry must be in the future.");
      return;
    }

    setSubmitting(true);
    try {
      const link = await createPaymentLink(me.merchant.id, {
        amountFils: amount,
        reference: reference.trim() || undefined,
        description: description.trim() || undefined,
        expiresAt: expiresAtIso,
      });
      navigate(`/dashboard/payment-links/${link.id}`, { replace: true });
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section>
      <h1>New payment link</h1>

      {error ? <p className="dash-error">{error}</p> : null}

      <form className="dash-form" onSubmit={(e) => void handleSubmit(e)}>
        <label>
          Amount (BHD)
          <input
            type="text"
            inputMode="decimal"
            placeholder="20.000"
            required
            value={amountFils}
            onChange={(e) => setAmountFils(e.target.value)}
          />
        </label>
        <p className="dash-muted dash-hint">{amountPreview(amountFils)}</p>
        <label>
          Reference (optional)
          <input type="text" value={reference} onChange={(e) => setReference(e.target.value)} />
        </label>
        <label>
          Description (optional)
          <input type="text" value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <label>
          Expires at
          <input
            type="datetime-local"
            required
            value={expiresAt}
            onChange={(e) => setExpiresAt(e.target.value)}
          />
        </label>
        <button type="submit" className="dash-button" disabled={submitting}>
          {submitting ? "Creating..." : "Create payment link"}
        </button>
      </form>

      <p>
        <Link to="/dashboard/payment-links">Back to payment links</Link>
      </p>
    </section>
  );
}
