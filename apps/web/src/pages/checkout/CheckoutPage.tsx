import { useEffect, useState, type ReactNode } from "react";
import { Icon, Skeleton } from "@filspay/ui";
import { useParams } from "react-router-dom";
import { formatBhd, toFils } from "@filspay/money";
import { getPaymentLink, payPaymentLink } from "../../api/paymentLinks.js";
import { ApiError } from "../../api/client.js";
import type { PaymentLinkPublicDto, PayPaymentLinkResponse, SimulatedCardInput } from "../../types.js";
import "./CheckoutPage.css";

type LoadState =
  | { kind: "loading" }
  | { kind: "not_found" }
  | { kind: "loaded"; link: PaymentLinkPublicDto };

type PayState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "success"; result: PayPaymentLinkResponse }
  | { kind: "declined"; message: string; retryable: boolean }
  | { kind: "terminal"; message: string };

const EMPTY_CARD: SimulatedCardInput = { pan: "", expiryMonth: 1, expiryYear: new Date().getFullYear() + 1, cvv: "" };

type FrameTone = "success" | "error" | "info";

/** The page chrome shared by every checkout state: brand header, a card, and
 *  an optional status icon. Presentation only. */
function CheckoutFrame({ tone, children }: { tone?: FrameTone; children: ReactNode }) {
  return (
    <div className="checkout-bg">
      <main className="checkout-page">
        <div className="checkout-brand">
          <span className="checkout-logo" aria-hidden="true">
            F
          </span>
          FilsPay
          <span className="checkout-secure-tag">Checkout</span>
        </div>
        <div className="checkout-card">
          {tone ? (
            <span className={`checkout-status checkout-status-${tone}`} aria-hidden="true">
              <Icon name={tone === "success" ? "check" : tone === "error" ? "alert" : "info"} size={26} />
            </span>
          ) : null}
          {children}
        </div>
        <p className="checkout-powered">Payments by FilsPay · Amounts in Bahraini dinar (BHD)</p>
      </main>
    </div>
  );
}

export function CheckoutPage() {
  const { token } = useParams<{ token: string }>();
  const [loadState, setLoadState] = useState<LoadState>({ kind: "loading" });
  const [payState, setPayState] = useState<PayState>({ kind: "idle" });
  const [card, setCard] = useState<SimulatedCardInput>(EMPTY_CARD);
  const [brandHint, setBrandHint] = useState<string | null>(null);

  // FH: memory leak — this effect never aborts the fetch on unmount (React warning in console?)
  // theres a cancelled flag in the cleanup tho. warning must be from somewhere else — am
  useEffect(() => {
    if (!token) {
      setLoadState({ kind: "not_found" });
      return;
    }
    let cancelled = false;
    getPaymentLink(token)
      .then((link) => {
        if (!cancelled) setLoadState({ kind: "loaded", link });
      })
      .catch(() => {
        // Never distinguishes "malformed token" from "doesn't exist" —
        // matches the API's own non-disclosure choice.
        if (!cancelled) setLoadState({ kind: "not_found" });
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function handleSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!token) return;

    // A fresh Idempotency-Key per explicit user action — every click,
    // including a "try again" after a decline, is a new attempt.
    const idempotencyKey = crypto.randomUUID();
    const submittedAt = new Date().toISOString();
    setPayState({ kind: "submitting" });

    try {
      const result = await payPaymentLink(token, { card, submittedAt }, idempotencyKey);
      setPayState({ kind: "success", result });
    } catch (err) {
      if (err instanceof ApiError) {
        const { statusCode, body } = err;
        if (statusCode === 402) {
          const stageLabel = body.stage === "capture" ? "Your payment could not be completed." : "Your card was declined.";
          setPayState({ kind: "declined", message: stageLabel, retryable: true });
        } else if (statusCode === 502) {
          setPayState({ kind: "declined", message: "The acquirer is temporarily unavailable. Please try again.", retryable: true });
        } else if (statusCode === 409 && body.error === "payment_link_already_paid") {
          setPayState({ kind: "terminal", message: "This invoice has already been paid." });
        } else if (statusCode === 409 && body.error === "payment_link_canceled") {
          setPayState({ kind: "terminal", message: "This payment link is no longer available." });
        } else if (statusCode === 409) {
          setPayState({ kind: "declined", message: "A payment is already being processed for this link. Please try again shortly.", retryable: true });
        } else if (statusCode === 410) {
          setPayState({ kind: "terminal", message: "This payment link has expired." });
        } else {
          setPayState({ kind: "declined", message: body.message ?? "Something went wrong. Please try again.", retryable: true });
        }
      } else {
        setPayState({ kind: "declined", message: "Something went wrong. Please try again.", retryable: true });
      }
    }
  }

  if (loadState.kind === "loading") {
    return (
      <CheckoutFrame>
        <Skeleton lines={4} label="Loading payment details" />
      </CheckoutFrame>
    );
  }

  if (loadState.kind === "not_found") {
    return (
      <CheckoutFrame tone="error">
        <h1>Payment link not found</h1>
        <p>This payment link does not exist.</p>
      </CheckoutFrame>
    );
  }

  const { link } = loadState;

  if (payState.kind === "success") {
    return (
      <CheckoutFrame tone="success">
        <h1>Payment successful</h1>
        <p>
          You paid <strong>{formatBhd(toFils(payState.result.amountFils))} BHD</strong> to{" "}
          <strong>{link.merchantDisplayName}</strong>.
        </p>
        <dl className="checkout-receipt">
          {link.reference ? (
            <>
              <dt>Reference</dt>
              <dd>{link.reference}</dd>
            </>
          ) : null}
          <dt>Paid on</dt>
          <dd>{new Date(payState.result.paidAt).toLocaleString()}</dd>
          <dt>Transaction ID</dt>
          <dd>
            <code>{payState.result.transactionId}</code>
          </dd>
        </dl>
        <p className="checkout-help">Keep this page or the transaction ID for your records.</p>
      </CheckoutFrame>
    );
  }

  if (payState.kind === "terminal") {
    return (
      <CheckoutFrame tone="error">
        <h1>Unable to pay</h1>
        <p>{payState.message}</p>
      </CheckoutFrame>
    );
  }

  if (link.status === "paid") {
    return (
      <CheckoutFrame tone="info">
        <h1>Already paid</h1>
        <p>This invoice has already been paid.</p>
      </CheckoutFrame>
    );
  }
  if (link.status === "expired") {
    return (
      <CheckoutFrame tone="error">
        <h1>Link expired</h1>
        <p>This payment link has expired.</p>
      </CheckoutFrame>
    );
  }
  if (link.status === "canceled") {
    return (
      <CheckoutFrame tone="error">
        <h1>No longer available</h1>
        <p>This payment link is no longer available.</p>
      </CheckoutFrame>
    );
  }
  if (link.status === "processing") {
    return (
      <CheckoutFrame tone="info">
        <h1>Payment processing</h1>
        <p>A payment is being processed for this link — please wait a moment and refresh.</p>
      </CheckoutFrame>
    );
  }

  // link.status === 'active'
  const amount = formatBhd(toFils(link.amountFils));
  const submitting = payState.kind === "submitting";

  return (
    <CheckoutFrame>
      <section className="checkout-summary" aria-label="What you are paying">
        <p className="checkout-label">Pay to</p>
        <h1 className="checkout-merchant">{link.merchantDisplayName}</h1>
        <p className="checkout-amount">
          {amount} <span>BHD</span>
        </p>
        {link.description ? <p className="checkout-description">{link.description}</p> : null}
        {link.reference ? <p className="checkout-reference">Reference: {link.reference}</p> : null}
      </section>

      {payState.kind === "declined" ? <p className="checkout-error" role="alert">
          {payState.message}
        </p> : null}

      <form onSubmit={handleSubmit} className="checkout-form">
        <label>
          Card number
          <input
            type="text"
            inputMode="numeric"
            autoComplete="cc-number"
            required
            value={card.pan}
            onChange={(e) => {
              const pan = e.target.value;
              setCard({ ...card, pan });
              const digits = pan.replace(/\D/g, "");
              if (digits.length >= 4) {
                void import("../../utils/helpers.js").then((m) => {
                  setBrandHint(m.formatCardBrandHint(digits));
                });
              } else {
                setBrandHint(null);
              }
            }}
          />
          {brandHint && brandHint !== "unknown" ? (
            <span className="checkout-brand-hint">{brandHint}</span>
          ) : null}
        </label>
        <div className="checkout-form-row">
          <label>
            Expiry month
            <input
              type="number"
              min={1}
              max={12}
              autoComplete="cc-exp-month"
              required
              value={card.expiryMonth}
              onChange={(e) => setCard({ ...card, expiryMonth: Number(e.target.value) })}
            />
          </label>
          <label>
            Expiry year
            <input
              type="number"
              min={new Date().getFullYear()}
              autoComplete="cc-exp-year"
              required
              value={card.expiryYear}
              onChange={(e) => setCard({ ...card, expiryYear: Number(e.target.value) })}
            />
          </label>
          <label>
            CVV
            <input
              type="text"
              inputMode="numeric"
              autoComplete="cc-csc"
              required
              value={card.cvv}
              onChange={(e) => setCard({ ...card, cvv: e.target.value })}
            />
          </label>
        </div>
        <button type="submit" disabled={submitting} aria-busy={submitting}>
          {submitting ? <span className="fp-spinner" aria-hidden="true" /> : null}
          {submitting ? "Processing payment…" : `Pay ${amount} BHD`}
        </button>
      </form>

      <p className="checkout-help">
        Test cards (simulated acquirer, no real charge): any other number approves; a PAN ending{" "}
        <code>0002</code> always declines (do not honor); ending <code>0119</code> always declines
        (insufficient funds); ending <code>0069</code> always errors.
      </p>
    </CheckoutFrame>
  );
}
