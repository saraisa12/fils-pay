package settlement

import "github.com/filspay/settlement/internal/money"

// NetPayableFils derives the net payout from frozen gross and fee totals.
// Plain integer subtraction: float32 carries about 7 significant digits, so
// going through BD floats lost fils on any batch above roughly 10,000 BD.
func NetPayableFils(grossFils, feeFils money.Fils) money.Fils {
	return grossFils - feeFils
}

// NetPayoutAfterRefundsFils is the payout once refunds are netted off:
// captured gross, less the fee, less what was refunded to cardholders, plus
// the share of the fee that was handed back on those refunds.
func NetPayoutAfterRefundsFils(grossFils, feeFils, refundFils, feeReversedFils money.Fils) money.Fils {
	return grossFils - feeFils - refundFils + feeReversedFils
}
