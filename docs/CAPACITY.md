# Capacity: what the checkout can serve, where the limit is, how to test it

## Scenario

`POST /v1/payment-links/:token/pay` (authorize then capture) with a fresh `Idempotency-Key` per request, one
single-use payment link each, against the acquirer simulator at its defaults (latency 100-400 ms, about 2%
declines and 2% errors). Declines (402) and acquirer errors (502) are expected at those rates; they are not
failures of the server.

## Measured (development container, 4 cores, Postgres on the same machine, one API process)

| DB pool (`PG_POOL_MAX`) | Successful checkouts / s | p50 at saturation | API CPU per checkout |
|---|---|---|---|
| 5 (default) | 9 | ~2.0 s (20 in flight) | ~10 ms |
| 10 | 17.5 | ~2.1 s | ~10 ms |
| 20 | 35 | ~1.6 s | ~7 ms |
| 40 | 69 | ~1.6 s | ~6 ms |

Overload: 400 simultaneous clients on a pool of 20 held throughput at about 31/s, with median latency about
10 s. Afterwards there were 0 unbalanced ledger groups and 0 paid links without a transaction.

These numbers are relative, not the hosted server's: that box has 1 vCPU (API capped at 0.5 vCPU / 512 MB)
and shares it with Postgres. Re-measure there and use that figure.

## Where the bottleneck is

`authorize` and `capture` each call the acquirer inside a database transaction, so one checkout holds a
database connection for roughly 2 x 250 ms. Throughput is about **pool size / 0.5 s**. CPU is not the limit:
at 6-10 ms per checkout the 0.5 vCPU cap alone would allow 60-80 per second, and Postgres shares that
vCPU, so plan for about 40-50.

## How to run it

```
npm i --no-save autocannon
# one-off: create single-use links in the database under test (each request consumes one)
#   insert into payment_links (merchant_id, token, amount_fils, reference, expires_at, created_by_type, created_by_id)
#   select '<merchantId>', 'plink_ld_'||g, 25000, 'load-'||g, now()+interval '1 day', 'merchant_session', gen_random_uuid()
#   from generate_series(0,19999) g;
DATABASE_URL=... node scripts/loadtest/checkout.cjs <PG_POOL_MAX> <connections> <seconds> <tokenOffset>
BASE_URL=http://<host> node scripts/loadtest/checkout.cjs 0 <connections> <seconds> <tokenOffset>   # a running server
```

Use a new `tokenOffset` for every run. Read `rps_ok`, `lat_p97_5` and the per-status `codes`. Ramp the
connection count (10, 20, 40, 80, 160): capacity is the highest rate where p97.5 stays under about 2 s and
failures stay near the simulator's 4%. Watch `docker stats` for the API container's memory (limit 512 MB).

## Not done yet

Load shedding: above the limit, requests queue instead of being refused quickly. The plan is to cap in-flight
checkouts at the pool size and answer `503` with `Retry-After`, raise `PG_POOL_MAX` to about 30, and keep the
compose restart policy and health check.
