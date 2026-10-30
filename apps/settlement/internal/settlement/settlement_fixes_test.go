package settlement

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/filspay/settlement/internal/money"
)

// Scheme file: the amount is the TRUNCATED figure, and the truncated fils are journaled.
func TestCloseBatch_SchemeAmountIsTruncatedAndResidueIsJournaled(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	merchantID := insertActiveMerchant(t, pool, 250)
	day := time.Date(2026, 5, 4, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(day)
	txnID, _ := insertCaptureEvent(t, pool, merchantID, 250, 4747, start.Add(time.Hour))

	res, err := CloseBatch(ctx, pool, merchantID, day)
	if err != nil {
		t.Fatalf("CloseBatch: %v", err)
	}

	var amountFils int64
	var amountText string
	if err := pool.QueryRow(ctx,
		`SELECT amount_fils, amount::text FROM scheme_export_lines WHERE settlement_batch_id = $1`, res.BatchID,
	).Scan(&amountFils, &amountText); err != nil {
		t.Fatalf("read scheme line: %v", err)
	}
	if amountFils != 4740 || amountText != "4.74" {
		t.Errorf("scheme line = %d fils / %q BD, want 4740 / \"4.74\" (never rounded up to 4.75)", amountFils, amountText)
	}

	var debit, credit int64
	if err := pool.QueryRow(ctx, `
		SELECT COALESCE(SUM(amount_fils) FILTER (WHERE account_id = 'scheme_rounding_residue' AND direction = 'debit'), 0),
		       COALESCE(SUM(amount_fils) FILTER (WHERE account_id = 'card_scheme_clearing' AND direction = 'credit'
		                                         AND description = 'scheme rounding residue'), 0)
		  FROM ledger_entries WHERE transaction_id = $1 AND settlement_batch_id = $2`, txnID, res.BatchID,
	).Scan(&debit, &credit); err != nil {
		t.Fatalf("read residue legs: %v", err)
	}
	if debit != 7 || credit != 7 {
		t.Errorf("residue legs = debit %d / credit %d, want 7 / 7", debit, credit)
	}
}

// A paid batch is final: MDR recalculation must leave it alone; an unpaid closed one is corrected.
func TestRecalculateMDR_NeverTouchesPaidBatches(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	merchantID := insertActiveMerchant(t, pool, 250)
	paidDay := time.Date(2026, 5, 5, 0, 0, 0, 0, time.UTC)
	closedDay := paidDay.AddDate(0, 0, 1)
	s1, _ := BusinessDayWindow(paidDay)
	s2, _ := BusinessDayWindow(closedDay)
	insertCaptureEvent(t, pool, merchantID, 250, 10_000, s1.Add(time.Hour))
	insertCaptureEvent(t, pool, merchantID, 250, 10_000, s2.Add(time.Hour))

	r1, err := CloseBatch(ctx, pool, merchantID, paidDay)
	if err != nil {
		t.Fatalf("close paid day: %v", err)
	}
	if _, err := PayoutBatch(ctx, pool, r1.BatchID); err != nil {
		t.Fatalf("payout: %v", err)
	}
	r2, err := CloseBatch(ctx, pool, merchantID, closedDay)
	if err != nil {
		t.Fatalf("close second day: %v", err)
	}

	if _, err := pool.Exec(ctx, `UPDATE merchants SET mdr_bps = 500 WHERE id = $1`, merchantID); err != nil {
		t.Fatalf("raise rate: %v", err)
	}
	result, err := RecalculateMDR(ctx, pool, merchantID, paidDay, closedDay.AddDate(0, 0, 1))
	if err != nil {
		t.Fatalf("RecalculateMDR: %v", err)
	}

	if result.BatchesConsidered != 1 || len(result.Adjusted) != 1 || result.Adjusted[0].BatchID != r2.BatchID {
		t.Fatalf("only the unpaid batch may be considered/adjusted, got %+v", result)
	}
	var paidFee int64
	if err := pool.QueryRow(ctx, `SELECT fee_fils FROM settlement_batches WHERE id = $1`, r1.BatchID).Scan(&paidFee); err != nil {
		t.Fatal(err)
	}
	if money.Fils(paidFee) != r1.FeeFils {
		t.Errorf("paid batch fee changed from %d to %d", r1.FeeFils, paidFee)
	}
}

// The lifetime volume counter is 64-bit: crossing 2^31 fils must not wrap or fail the close.
func TestCloseBatch_PlatformVolumeCounterSurvivesInt32Max(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	var before int64
	if err := pool.QueryRow(ctx, `SELECT total_processed_fils FROM platform_stats WHERE id = 1`).Scan(&before); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `UPDATE platform_stats SET total_processed_fils = $1 WHERE id = 1`, before)
	})
	const nearMax = int64(2_147_483_000)
	if _, err := pool.Exec(ctx, `UPDATE platform_stats SET total_processed_fils = $1 WHERE id = 1`, nearMax); err != nil {
		t.Fatal(err)
	}

	merchantID := insertActiveMerchant(t, pool, 250)
	day := time.Date(2026, 5, 6, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(day)
	insertCaptureEvent(t, pool, merchantID, 250, 5_000, start.Add(time.Hour))
	if _, err := CloseBatch(ctx, pool, merchantID, day); err != nil {
		t.Fatalf("CloseBatch near the int32 limit: %v", err)
	}

	var after int64
	if err := pool.QueryRow(ctx, `SELECT total_processed_fils FROM platform_stats WHERE id = 1`).Scan(&after); err != nil {
		t.Fatal(err)
	}
	if after != nearMax+5_000 {
		t.Errorf("counter = %d, want %d (no wrap-around)", after, nearMax+5_000)
	}
}

func TestVolumeTierThresholdUsesInt64(t *testing.T) {
	if got := VolumeTierMdrBonusBps(3_000_000_000); got != 15 {
		t.Errorf("bonus above the old int32 range = %d, want 15", got)
	}
	_ = uuid.Nil
}
