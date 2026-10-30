package settlement

import (
	"context"
	"sync"
	"testing"

	"github.com/google/uuid"
)

// B050 + B063: a paid batch gets exactly one payout disbursement and one
// settlement.paid event, even when two runs (daemon + CLI) race, and even when
// the merchant has no webhook endpoints.
func TestPaidBatchRecordedOnceEvenWhenRunsRace(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	merchantID := insertActiveMerchant(t, pool, 250)

	var batchID uuid.UUID
	if err := pool.QueryRow(ctx, `
		INSERT INTO settlement_batches (merchant_id, batch_date, status, gross_fils, fee_fils, net_payout_fils, closed_at, paid_at)
		VALUES ($1, '2026-04-12', 'paid', 10000, 250, 9750, now(), now())
		RETURNING id
	`, merchantID).Scan(&batchID); err != nil {
		t.Fatalf("seed paid batch: %v", err)
	}

	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := EnqueuePayoutNotifications(ctx, pool); err != nil {
				t.Errorf("EnqueuePayoutNotifications: %v", err)
			}
		}()
	}
	wg.Wait()

	var events, disbursements int
	var amount int64
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM outbox_events WHERE event_type = 'settlement.paid' AND aggregate_id = $1`, batchID).Scan(&events); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*), COALESCE(max(amount_fils), 0) FROM settlement_payout_disbursements WHERE settlement_batch_id = $1`, batchID).Scan(&disbursements, &amount); err != nil {
		t.Fatal(err)
	}
	if events != 1 {
		t.Errorf("settlement.paid events = %d, want 1", events)
	}
	if disbursements != 1 || amount != 9750 {
		t.Errorf("disbursements = %d (amount %d), want exactly 1 for 9750 fils, recorded with no webhook endpoint", disbursements, amount)
	}
}
