#!/usr/bin/env bash
# Runs every test suite, each against its OWN freshly migrated database, so one suite's leftover rows
# cannot break another's (the API tests leave outbox rows that make the reporting tests fail when they
# share a database). Exits non-zero if anything fails.
#
#   scripts/ai/verify.sh            # everything
#   scripts/ai/verify.sh api go     # only the named suites: api reporting money events web scripts go
#
# Needs a Postgres you can create databases on. Defaults match the dev setup in docs/RUN_LOCALLY.md;
# override with PGHOST, PGPORT, PGUSER, PGPASSWORD.
set -uo pipefail
cd "$(dirname "$0")/../.."

export PGHOST="${PGHOST:-localhost}" PGPORT="${PGPORT:-5432}" PGUSER="${PGUSER:-filspay}" PGPASSWORD="${PGPASSWORD:-filspay}"
export WEBHOOK_SECRET_ENCRYPTION_KEY="${WEBHOOK_SECRET_ENCRYPTION_KEY:-Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=}" # dev/test key only
SUITES=("$@"); [ ${#SUITES[@]} -eq 0 ] && SUITES=(money events api reporting web scripts go)
FAILED=()

fresh_db() { # $1 = suite name; prints the DATABASE_URL of a new migrated database
  local name="filspay_verify_${1}_$$"
  psql -q -d postgres -c "DROP DATABASE IF EXISTS $name" -c "CREATE DATABASE $name" >&2 || return 1
  local url="postgres://$PGUSER:$PGPASSWORD@$PGHOST:$PGPORT/$name"
  DATABASE_URL="$url" npm run -s migrate >/dev/null 2>&1 || { echo "migrate failed for $name" >&2; return 1; }
  echo "$url"
}
drop_db() { psql -q -d postgres -c "DROP DATABASE IF EXISTS ${1##*/}" >/dev/null 2>&1; }

for s in "${SUITES[@]}"; do
  echo "=== $s"
  url=""
  case "$s" in
    money|events|web) (cd "$( [ "$s" = web ] && echo apps/web || echo packages/$s )" && npm test --silent 2>&1 | tail -4) ; rc=${PIPESTATUS[0]} ;;
    api|reporting)    url=$(fresh_db "$s") || { FAILED+=("$s"); continue; }
                      (cd apps/$s && DATABASE_URL="$url" npm test --silent 2>&1 | grep -E "^# (tests|pass|fail)|^not ok") ; rc=${PIPESTATUS[0]} ;;
    scripts)          url=$(fresh_db "$s") || { FAILED+=("$s"); continue; }
                      DATABASE_URL="$url" npx tsx --test scripts/*.test.ts 2>&1 | grep -E "^# (tests|pass|fail)|^not ok"; rc=${PIPESTATUS[0]} ;;
    go)               url=$(fresh_db "$s") || { FAILED+=("$s"); continue; }
                      (cd apps/settlement && DATABASE_URL="$url" go test -count=1 ./... 2>&1 | grep -v "no test files"); rc=${PIPESTATUS[0]} ;;
    *)                echo "unknown suite $s"; rc=1 ;;
  esac
  [ -n "$url" ] && drop_db "$url"
  [ "${rc:-0}" -ne 0 ] && FAILED+=("$s")
done

echo
if [ ${#FAILED[@]} -eq 0 ]; then echo "ALL SUITES PASSED"; else echo "FAILED: ${FAILED[*]}"; exit 1; fi
