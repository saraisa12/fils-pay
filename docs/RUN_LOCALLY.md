# Run FilsPay locally (no Docker)

You need: **Node 20+**, **PostgreSQL 16**, and optionally **Go 1.22** (only for the settlement service).

## 1. Database

```
psql -U postgres -c "CREATE USER filspay SUPERUSER PASSWORD 'filspay'" -c "CREATE DATABASE filspay OWNER filspay"
```

On Windows `psql` is in `C:\Program Files\PostgreSQL\16\bin`; add it to PATH or use the full path.

## 2. Install, migrate, seed

bash:

```
npm install
export DATABASE_URL=postgres://filspay:filspay@localhost:5432/filspay
export WEBHOOK_SECRET_ENCRYPTION_KEY=Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=   # dev/test only
npm run migrate && npm run seed
```

PowerShell: use `$env:DATABASE_URL="..."` and `$env:WEBHOOK_SECRET_ENCRYPTION_KEY="..."` for the same two
variables (they must be set again in every new terminal window).

## 3. Start the services

```
OTP_DEV_EXPOSE=true npx tsx apps/api/src/index.ts       # API on :3000, login page shows the one-time code
(cd apps/web && VITE_API_BASE_URL= npx vite)            # dashboard on :5173 (proxies /v1 to the API)
(cd apps/reporting && npx tsx src/index.ts)             # optional: fills the overview charts
(cd apps/settlement && go run ./cmd/settlement run-batch --date=YYYY-MM-DD)   # optional: close a day
```

PowerShell: set `$env:OTP_DEV_EXPOSE="true"` and `$env:VITE_API_BASE_URL=""` before the commands.

## 4. Log in

Open http://localhost:5173/dashboard/login.

| Merchant ID | Email | Password |
|---|---|---|
| `9972daab-2c86-459f-9d78-3fe1be4e3280` (Alpha Retail Co) | `owner@alpharetail.example` | `FilsPaySeed!2026` |

The seed ids are deterministic. List all of them with
`psql -U filspay -d filspay -c "select id, display_name from merchants"`. Admin console accounts:
`support@filspay.test`, `finance@filspay.test`, `superadmin@filspay.test` (password `FilsPayAdminSeed!2026`).
Test card: `4242424242424242`, expiry 12/2030, CVV 123 (a PAN ending `0002` or `0119` declines, `0069` is an acquirer error).

## 5. Test

```
scripts/ai/verify.sh          # every suite, each on its own clean database
npm run typecheck
```

## Docker

See `ops/README.md`. The compose file needs four secrets in the environment (`POSTGRES_PASSWORD`,
`SETTLEMENT_INTERNAL_TOKEN`, `WEBHOOK_SECRET_ENCRYPTION_KEY`, `ACQUIRER_CALLBACK_SIGNING_SECRET`).
