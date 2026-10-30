-- The acquirer redelivers callbacks (at-least-once). acquirer_callback_notes had no uniqueness on
-- callback_id, and the "processed_events" table the changelog mentions does not exist, so every
-- redelivery stored another identical note (FP-201, reopened).

-- Existing duplicates (exact redeliveries) would stop the unique index from being created: keep the
-- first note of each (transaction, callback) and drop the later copies.
DELETE FROM acquirer_callback_notes a
 USING acquirer_callback_notes b
 WHERE a.transaction_id = b.transaction_id
   AND a.callback_id = b.callback_id
   AND (a.created_at, a.id) > (b.created_at, b.id);

CREATE UNIQUE INDEX uq_acquirer_callback_notes_callback
    ON acquirer_callback_notes (transaction_id, callback_id);
