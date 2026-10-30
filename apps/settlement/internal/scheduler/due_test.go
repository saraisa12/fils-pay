package scheduler

import (
	"testing"
	"time"
)

// The Bahrain day starts at 21:00 UTC. With a 15 minute delay the close for the
// day that just ended is due from 00:15 Bahrain (21:15 UTC), not from 03:15
// Bahrain (00:15 UTC), which is what the UTC date gave.
func TestDueBusinessDate_ClosesJustAfterBahrainMidnight(t *testing.T) {
	cases := []struct {
		name     string
		now      time.Time
		wantDue  bool
		wantDate string // the business day to close
	}{
		{"00:05 Bahrain: delay not elapsed yet", time.Date(2026, 10, 30, 21, 5, 0, 0, time.UTC), false, ""},
		{"00:15 Bahrain: due, closes the 30th", time.Date(2026, 10, 30, 21, 15, 0, 0, time.UTC), true, "2026-10-30"},
		{"00:20 Bahrain: due, closes the 30th", time.Date(2026, 10, 30, 21, 20, 0, 0, time.UTC), true, "2026-10-30"},
		{"02:00 Bahrain: still the 30th", time.Date(2026, 10, 30, 23, 0, 0, 0, time.UTC), true, "2026-10-30"},
		{"03:15 Bahrain (00:15 UTC): same day, not the 31st's", time.Date(2026, 10, 31, 0, 15, 0, 0, time.UTC), true, "2026-10-30"},
		{"noon Bahrain on the 31st: closes the 30th", time.Date(2026, 10, 31, 9, 0, 0, 0, time.UTC), true, "2026-10-30"},
		{"23:59 Bahrain on the 30th: closes the 29th", time.Date(2026, 10, 30, 20, 59, 0, 0, time.UTC), true, "2026-10-29"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			date, due := dueBusinessDate(tc.now, 15)
			if due != tc.wantDue {
				t.Fatalf("due = %v, want %v", due, tc.wantDue)
			}
			if due && date.Format("2006-01-02") != tc.wantDate {
				t.Errorf("business date = %s, want %s", date.Format("2006-01-02"), tc.wantDate)
			}
		})
	}
}
