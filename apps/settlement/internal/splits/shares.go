package splits

import (
	"sort"

	"github.com/filspay/settlement/internal/money"
)

// ChildWeight is one sub-merchant's configured share of a parent's payout.
type ChildWeight struct {
	WeightBps int64
}

// ChildShares distributes netPayout across children by their weights so that
// the shares ALWAYS add up to netPayout exactly.
//
// Applying the rate to each child on its own rounded every share separately
// (e.g. 100 fils over thirds gave 33+33+33): the missing fils vanished from the
// ledger on every batch. This is the largest-remainder method, like
// allocateRemainder in packages/money: each child gets the floor of its exact
// share, and the fils left over go one each to the children with the largest
// remainders (ties to the lower index), so the result is deterministic.
//
// Weights are used relative to their own sum, so a configuration that does not
// total 10000 bps still pays out the whole net and never more.
func ChildShares(netPayout money.Fils, children []ChildWeight) []money.Fils {
	out := make([]money.Fils, len(children))
	var sumWeights int64
	for _, c := range children {
		sumWeights += c.WeightBps
	}
	if len(children) == 0 || sumWeights <= 0 || netPayout <= 0 {
		return out
	}

	remainders := make([]int64, len(children))
	var allocated int64
	for i, c := range children {
		product := int64(netPayout) * c.WeightBps
		base := product / sumWeights
		out[i] = money.Fils(base)
		remainders[i] = product % sumWeights
		allocated += base
	}

	order := make([]int, len(children))
	for i := range order {
		order[i] = i
	}
	sort.SliceStable(order, func(a, b int) bool { return remainders[order[a]] > remainders[order[b]] })

	for k := 0; allocated < int64(netPayout) && k < len(order); k++ {
		out[order[k]]++
		allocated++
	}
	return out
}
