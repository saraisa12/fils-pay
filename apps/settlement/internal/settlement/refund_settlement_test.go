package settlement

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/filspay/settlement/internal/money"
)

// insertSucceededRefund records one refund row the way apps/api's
// processRefund does (the ledger legs are not needed by CloseBatch).
func insertSucceededRefund(t *testing.T, pool *pgxpool.Pool, merchantID, txnID uuid.UUID, amount, feeReversed money.Fils, occurredAt time.Time) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	err := pool.QueryRow(context.Background(), `
		INSERT INTO refunds (transaction_id, merchant_id, amount_fils, fee_reversed_fils, status,
		                     acquirer_reference, reason, created_by_type, created_by_id, occurred_at)
		VALUES ($1, $2, $3, $4, 'succeeded', 'acq-refund', 'test', 'merchant_api_key', gen_random_uuid(), $5)
		RETURNING id
	`, txnID, merchantID, int64(amount), int64(feeReversed), occurredAt).Scan(&id)
	if err != nil {
		t.Fatalf("insertSucceededRefund: %v", err)
	}
	return id
}

func TestCloseBatch_NetsRefundsOffThePayout(t *testing.T) {
	pool := mustPool(t)
	merchantID := insertActiveMerchant(t, pool, 250)
	day := time.Date(2026, 4, 10, 0, 0, 0, 0, time.UTC)
	at := time.Date(2026, 4, 10, 6, 0, 0, 0, time.UTC) // 09:00 Bahrain

	txnID, fee := insertCaptureEvent(t, pool, merchantID, 250, 10_000, at)
	refundID := insertSucceededRefund(t, pool, merchantID, txnID, 4_000, 100, at.Add(time.Hour))

	res, err := CloseBatch(context.Background(), pool, merchantID, day)
	if err != nil {
		t.Fatalf("CloseBatch: %v", err)
	}
	// 10000 gross - 250 fee - 4000 refunded + 100 of the fee handed back
	if want := money.Fils(10_000) - fee - 4_000 + 100; res.NetPayoutFils != want {
		t.Errorf("net payout = %d, want %d", res.NetPayoutFils, want)
	}
	if res.RefundFils != 4_000 {
		t.Errorf("refund fils = %d, want 4000", res.RefundFils)
	}

	var batchID *uuid.UUID
	if err := pool.QueryRow(context.Background(), `SELECT settlement_batch_id FROM refunds WHERE id = $1`, refundID).Scan(&batchID); err != nil {
		t.Fatalf("read refund: %v", err)
	}
	if batchID == nil || *batchID != res.BatchID {
		t.Errorf("refund was not stamped with the batch id (got %v, want %s)", batchID, res.BatchID)
	}

	// Closing again must not net the same refund twice.
	again, err := CloseBatch(context.Background(), pool, merchantID, day)
	if err != nil {
		t.Fatalf("second CloseBatch: %v", err)
	}
	if !again.AlreadyClosed || again.NetPayoutFils != res.NetPayoutFils {
		t.Errorf("re-close changed the batch: %+v", again)
	}
}

func TestCloseBatch_RefundBiggerThanTheDayCarriesForward(t *testing.T) {
	pool := mustPool(t)
	merchantID := insertActiveMerchant(t, pool, 250)
	day1 := time.Date(2026, 4, 11, 0, 0, 0, 0, time.UTC)
	day2 := day1.AddDate(0, 0, 1)

	// Day 1 captures 1,000 fils; a 5,000 fils refund of an older order lands that day.
	txnID, _ := insertCaptureEvent(t, pool, merchantID, 250, 1_000, time.Date(2026, 4, 11, 6, 0, 0, 0, time.UTC))
	refundID := insertSucceededRefund(t, pool, merchantID, txnID, 5_000, 0, time.Date(2026, 4, 11, 9, 0, 0, 0, time.UTC))

	r1, err := CloseBatch(context.Background(), pool, merchantID, day1)
	if err != nil {
		t.Fatalf("CloseBatch day1: %v", err)
	}
	if r1.NetPayoutFils < 0 || r1.RefundFils != 0 {
		t.Fatalf("day 1 should not take a refund that would make the payout negative: %+v", r1)
	}

	// Day 2 captures 20,000 fils, which is enough to absorb the carried refund.
	insertCaptureEvent(t, pool, merchantID, 250, 20_000, time.Date(2026, 4, 12, 6, 0, 0, 0, time.UTC))
	r2, err := CloseBatch(context.Background(), pool, merchantID, day2)
	if err != nil {
		t.Fatalf("CloseBatch day2: %v", err)
	}
	if r2.RefundFils != 5_000 {
		t.Errorf("day 2 refund fils = %d, want 5000 carried forward", r2.RefundFils)
	}
	var batchID *uuid.UUID
	_ = pool.QueryRow(context.Background(), `SELECT settlement_batch_id FROM refunds WHERE id = $1`, refundID).Scan(&batchID)
	if batchID == nil || *batchID != r2.BatchID {
		t.Errorf("carried refund should belong to day 2's batch, got %v", batchID)
	}
}

func TestNetPayableFilsIsExactForLargeBatches(t *testing.T) {
	gross, fee := money.Fils(123_456_789_012), money.Fils(3_086_419_725)
	if got, want := NetPayableFils(gross, fee), gross-fee; got != want {
		t.Errorf("NetPayableFils = %d, want %d", got, want)
	}
}
