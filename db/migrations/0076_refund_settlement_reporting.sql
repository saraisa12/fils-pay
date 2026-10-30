-- Refunds (FP-300): settlement nets them, reporting counts them.

-- A settlement batch now carries what refunds took off the payout:
--   net_payout_fils = gross_fils - fee_fils - refund_fils + fee_reversed_fils
ALTER TABLE settlement_batches
    ADD COLUMN refund_fils       BIGINT NOT NULL DEFAULT 0 CHECK (refund_fils >= 0),
    ADD COLUMN fee_reversed_fils BIGINT NOT NULL DEFAULT 0 CHECK (fee_reversed_fils >= 0);

ALTER TABLE merchant_payout_trends
    ADD COLUMN refund_fils       BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN fee_reversed_fils BIGINT NOT NULL DEFAULT 0;

-- Daily refund activity next to the daily capture activity (Asia/Bahrain day).
ALTER TABLE merchant_daily_volume
    ADD COLUMN refund_count      INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN refund_gross_fils BIGINT  NOT NULL DEFAULT 0;

-- 0072 joined transactions on refunds.id (matches nothing) and counted each
-- transaction's captured amount once per refund. Rebuild it: join on
-- transaction_id and count each refunded transaction once per day.
DROP MATERIALIZED VIEW IF EXISTS refund_merchant_summary;

CREATE MATERIALIZED VIEW refund_merchant_summary AS
WITH r AS (
    SELECT merchant_id,
           transaction_id,
           date_trunc('day', occurred_at AT TIME ZONE 'Asia/Bahrain') AS business_date,
           amount_fils,
           fee_reversed_fils
      FROM refunds
     WHERE status = 'succeeded'
),
agg AS (
    SELECT merchant_id, business_date,
           COUNT(*)               AS refund_count,
           SUM(amount_fils)       AS total_refunded_fils,
           SUM(fee_reversed_fils) AS total_fee_reversed_fils
      FROM r
     GROUP BY merchant_id, business_date
),
cap AS (
    SELECT d.merchant_id, d.business_date, SUM(t.captured_fils) AS original_captured_fils
      FROM (SELECT DISTINCT merchant_id, business_date, transaction_id FROM r) d
      JOIN transactions t ON t.id = d.transaction_id
     GROUP BY d.merchant_id, d.business_date
)
SELECT agg.merchant_id, agg.business_date, agg.refund_count, agg.total_refunded_fils,
       agg.total_fee_reversed_fils, cap.original_captured_fils
  FROM agg
  JOIN cap ON cap.merchant_id = agg.merchant_id AND cap.business_date = agg.business_date;

CREATE UNIQUE INDEX idx_refund_merchant_summary_pk
    ON refund_merchant_summary (merchant_id, business_date);
