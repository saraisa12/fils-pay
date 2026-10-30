package internalapi

import (
	"context"
	"net/http"
	"testing"
	"time"
)

// B060: the admin "Rebuild cached balances" button must rebuild from the
// ledger, like the `settlement rebuild-balances` CLI. A merchant whose capture
// has not been settled yet has a ledger balance but no scheme-export line, so
// the old view-based rebuild reset their balance to 0.
func TestRebuildBalances_UsesLedgerNotSettledBatches(t *testing.T) {
	pool := mustPool(t)
	server := newTestServer(t, pool)

	merchantID := insertActiveMerchant(t, pool)
	// A captured payment that has NOT been put into a settlement batch yet.
	insertCaptureEvent(t, pool, merchantID, 12000, time.Date(2026, 4, 12, 9, 0, 0, 0, time.UTC))

	// The cached balance is correct before anyone presses the button.
	_, err := pool.Exec(context.Background(), `
		INSERT INTO merchant_balances (merchant_id, cached_payable_fils, updated_at)
		VALUES ($1, 12000, now())
		ON CONFLICT (merchant_id) DO UPDATE SET cached_payable_fils = 12000
	`, merchantID)
	if err != nil {
		t.Fatalf("seed cached balance: %v", err)
	}

	resp := post(t, server, "/internal/rebuild-balances", "Bearer "+testToken, "")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}

	var persisted int64
	err = pool.QueryRow(context.Background(),
		`SELECT cached_payable_fils FROM merchant_balances WHERE merchant_id = $1`, merchantID).Scan(&persisted)
	if err != nil {
		t.Fatalf("query persisted balance: %v", err)
	}
	if persisted != 12000 {
		t.Errorf("after rebuild cached_payable_fils = %d, want 12000 (the ledger balance); "+
			"0 means the rebuild ignored unsettled captures", persisted)
	}
}
