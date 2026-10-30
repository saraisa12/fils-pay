package splits

import (
	"testing"

	"github.com/filspay/settlement/internal/money"
)

// Whatever the net and the weights, the children together receive exactly the net payout.
func TestChildShares_AlwaysSumToNetExactly(t *testing.T) {
	cases := []struct {
		net     money.Fils
		weights []int64
	}{
		{100, []int64{3333, 3333, 3334}},
		{100, []int64{3333, 3333, 3333}}, // does not total 10000: still pays out exactly the net
		{1, []int64{5000, 5000}},
		{7, []int64{1, 1, 1, 1, 1, 1, 1}},
		{999_999, []int64{2500, 2500, 2500, 2500}},
		{12_345_678, []int64{1111, 2222, 3333, 3334}},
		{3, []int64{10000}},
		{0, []int64{5000, 5000}},
	}
	for _, tc := range cases {
		children := make([]ChildWeight, len(tc.weights))
		for i, w := range tc.weights {
			children[i] = ChildWeight{WeightBps: w}
		}
		var total money.Fils
		for _, s := range ChildShares(tc.net, children) {
			if s < 0 {
				t.Fatalf("negative share for net=%d weights=%v", tc.net, tc.weights)
			}
			total += s
		}
		if total != tc.net {
			t.Errorf("net=%d weights=%v: shares sum to %d", tc.net, tc.weights, total)
		}
	}
}

// Leftover fils go to the largest remainders, ties to the earlier child, so results are stable.
func TestChildShares_LeftoverGoesToLargestRemainderThenLowerIndex(t *testing.T) {
	got := ChildShares(100, []ChildWeight{{3333}, {3333}, {3334}})
	want := []money.Fils{33, 33, 34}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("shares = %v, want %v", got, want)
		}
	}
	got = ChildShares(10, []ChildWeight{{5000}, {2500}, {2500}})
	if got[0] != 5 || got[1]+got[2] != 5 {
		t.Fatalf("shares = %v", got)
	}
}
