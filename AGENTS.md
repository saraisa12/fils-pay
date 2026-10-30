# FilsPay: instructions for AI coding agents

These rules were rewritten after the codebase audit (October 2026). The previous versions of this file,
`CLAUDE.md` and `.cursorrules` contained claims that were false and made agents reproduce bugs; what they
got wrong is listed in `docs/AI_USAGE.md`. Everything below has been checked against the code, the ADRs
and a running system. If something here turns out to be wrong, fix this file in the same change.

## First principle: verify, do not trust

- A comment, an ADR, a postmortem, a test name or an AI answer ("Claude says...") is a claim, not a fact.
  Check it against the code and by running it before you build on it.
- When code, docs and tests disagree, work out which one is right by reproducing the behaviour and reading
  the intent (ADR-0001, the briefing, the money package tests). Do not default to "the docs win" or
  "the tests win".
- Read the diff before you commit it. Explain every change in terms of what was wrong and why.

## Money (ADR-0001)

- **1 BD = 1000 fils.** Everything is stored and computed as whole integer fils (`*_fils`, BIGINT).
  The branded `Fils` type in `packages/money` is fils, not cents.
- Parse text amounts with `parseBhdToFils` ("4.75" is 4750, never 475). Format with `formatBhd`.
  Never `parseFloat`, `toFixed(2)`, `* 100`, `/ 1000` on money, and never `float32`/`float64` in Go for money.
- Rates are integer basis points; `applyRateFils` rounds half to even. Splits use largest-remainder
  (`allocateRemainder` / Go `ChildShares`) so shares always sum to the total.
- The only place a 2-decimal amount is produced is the scheme file at export (truncate to a multiple of
  10 fils; the truncated fils are journaled as residue).
- `packages/money` and `apps/settlement/internal/money` must behave identically. Change one only with a
  test, and mirror the change in the other.
- Money columns are BIGINT. Postgres `INTEGER` is 32-bit (max 2,147,483,647).

## Time

- The settlement business day is **Asia/Bahrain midnight to midnight** (UTC+3, no DST). Anything that means
  "today" or "yesterday" for settlement must be computed in Bahrain time (`InBusinessDayZone`), not from the
  UTC date. The daily close is due 15 minutes after Bahrain midnight.
- Calendar-month finance reports are a known open question (ADR-0003); say so rather than assume.

## Settlement and the ledger

- `ledger_entries` is the source of truth. `merchant_balances` is a cache; any "rebuild" reads the ledger.
- Neither the Go service nor the TypeScript API is automatically "the reference". They must agree; when they
  do not, find out which one matches the ledger and the ADRs.
- Closed-and-paid batches are final. Refunds are netted off the next payout (`net = gross - fee - refunds +
  fee returned`) and never push a payout below zero (the refund carries to a later day).
- Test merchants (`test_mode`) must never be settled. (Known open bug B014: the admin "recompute statuses" tool can clear `test_mode`; do not rely on that tool.)

## Security rules that were violated and fixed

- Anything an attacker could guess or brute-force uses `crypto` (OTP codes, session tokens, API keys,
  payment link tokens, invite codes). Never `Math.random`.
- Every query for merchant data is scoped by the merchant from the authenticated session or API key, never
  by an id from the URL or body alone. A foreign resource answers 404.
- Roles are enforced on the server for every route that changes state. A hidden button is not a control.
- Admin impersonation ("view as merchant") is read-only. Approvals are compared by account id.
- Signatures are computed and verified over the exact raw bytes, with a fresh timestamp and a constant-time
  comparison. Redeliveries are deduplicated by a unique index, not by hope.
- Outbound webhooks in production go to public https addresses only (SSRF guard in `webhooks/ssrf.ts`).
- A money-moving operation locks the row it reads, validates after the lock, and is idempotent
  (`Idempotency-Key`). Never validate in one transaction and write in another.

## Tests

- Tests are evidence, not scripture. If a test asserts behaviour that contradicts ADR-0001, the briefing
  or common sense (for example `4.75` imports as `475`), fix the test and say why in a comment or the
  commit message. Do not bend the code to a wrong test, and do not delete tests to get green.
- Add new behaviour as new test files named `*.new.test.ts` / `*_test.go` next to the code.
- Prove a regression test is real: it must fail without the fix and pass with it.
- Run everything on **clean databases**: `scripts/ai/verify.sh` (each suite gets its own migrated database;
  the API tests leave rows that break the reporting tests if they share one).

## Commands

```
npm install
export DATABASE_URL=postgres://filspay:filspay@localhost:5432/filspay
export WEBHOOK_SECRET_ENCRYPTION_KEY=Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=   # dev/test only
npm run migrate && npm run seed
npx tsx apps/api/src/index.ts                   # API :3000   (OTP_DEV_EXPOSE=true shows login codes in dev)
(cd apps/web && VITE_API_BASE_URL= npx vite)    # dashboard :5173, proxies /v1 to the API
(cd apps/settlement && go run ./cmd/settlement run-batch --date=YYYY-MM-DD)
scripts/ai/verify.sh                            # all test suites, clean databases
npm run typecheck
```

More in `docs/RUN_LOCALLY.md`. Compose stack: `ops/README.md`.

## Working agreements

- One bug per commit where possible: `fix(Bxxx): <what was wrong>`; log it in the bug tracker with the
  commit id and an explanation of what was wrong, why, and what it breaks.
- Never force-push. Do not edit a migration that may already have run; add a new numbered one.
- Do not run `scripts/reconcile_march.ts` (not idempotent) or `scripts/expire_holds.ts` against real data
  without reading them first.
- Secrets come from the environment (`ops/README.md`); never commit them.

## Repository map

`apps/api` (TS API) · `apps/settlement` (Go batch close and payouts) · `apps/reporting` (outbox to rollups) ·
`apps/web` (checkout and dashboard) · `apps/admin` (admin console) · `packages/money`, `packages/events` ·
`db/migrations`, `db/seed` · `ops` (compose, Dockerfiles) · `docs` (architecture, ADRs, runbooks, AI setup).
