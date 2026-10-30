-- B050 + B063: a paid settlement batch gets exactly one payout disbursement
-- record and exactly one settlement.paid event.
--
-- B050: the disbursement used to be written as a side effect of each webhook
-- delivery, so a merchant with two endpoints got two payout records and one
-- with none got no record. It is now written once per batch by apps/settlement
-- (EnqueuePayoutNotifications); this index makes a second row impossible.
--
-- B063: the daemon and the `run-batch` CLI could both pass the NOT EXISTS
-- check and enqueue settlement.paid twice. This partial index makes the second
-- insert a no-op (ON CONFLICT DO NOTHING in payout_notify.go).
--
-- If either CREATE fails, duplicates already exist: they are payout records,
-- so finance must review them before anything is removed. Nothing is deleted
-- here on purpose.
CREATE UNIQUE INDEX uq_settlement_payout_disbursements_batch
    ON settlement_payout_disbursements (settlement_batch_id);

CREATE UNIQUE INDEX uq_outbox_settlement_paid_batch
    ON outbox_events (event_type, aggregate_id)
    WHERE event_type = 'settlement.paid';
