/** B073: the streamed CSV export returns every row, even when many share a timestamp across a page boundary. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { streamTransactionsExportCsv } from "./exportCsv.js";
import { issueApiKeyInTx } from "../apiKeys/issue.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("exportStream.test.ts requires DATABASE_URL");
const pool = new Pool({ connectionString: databaseUrl, max: 3 });
after(async () => pool.end());

async function merchantWith(count: number): Promise<string> {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps, status) VALUES ($1, 250, 'active') RETURNING id`,
    [`export-stream-${randomUUID()}`],
  );
  const merchantId = m.rows[0]!.id;
  // Every row has the same timestamp: the worst case for a page boundary.
  await pool.query(
    `INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, reference, acquirer_reference, occurred_at)
     SELECT $1, 'captured', 1000, 1000, 'ref-' || g, 'acq_' || gen_random_uuid(), '2026-04-01T09:00:00Z'
       FROM generate_series(1, $2) g`,
    [merchantId, count],
  );
  return merchantId;
}

test("B073: streaming export returns every row across page boundaries", async () => {
  const merchantId = await merchantWith(2500);
  let csv = "";
  await streamTransactionsExportCsv(pool, { merchantId }, (chunk) => {
    csv += chunk;
  });
  const lines = csv.trim().split("\n");
  assert.equal(lines.length, 1 + 2500, "header plus one line per transaction");
  assert.equal(new Set(lines.slice(1).map((l) => l.split(",")[0])).size, 2500, "no duplicates");
});

test("B073: GET /v1/transactions/export streams the full CSV", async () => {
  const merchantId = await merchantWith(1200);
  const admin = await pool.query<{ id: string }>(
    `INSERT INTO admin_users (email, password_hash, display_name, role) VALUES ($1, 'x', 'Export Test', 'super_admin') RETURNING id`,
    [`export-${randomUUID()}@admin.test`],
  );
  const client = await pool.connect();
  let rawKey: string;
  try {
    rawKey = (
      await issueApiKeyInTx(client, { nodeEnv: "test" }, { merchantId, label: "export-test", createdByAdminUserId: admin.rows[0]!.id })
    ).rawKey;
  } finally {
    client.release();
  }
  const app = buildApp(
    loadConfig({
      DATABASE_URL: databaseUrl,
      NODE_ENV: "test",
      INTERNAL_API_TOKEN: "test-internal-token",
      WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
    }),
    pool,
  );
  try {
    const res = await app.inject({
      method: "GET",
      url: "/v1/transactions/export",
      headers: { authorization: `Bearer ${rawKey}` },
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.match(String(res.headers["content-type"]), /text\/csv/);
    assert.equal(res.body.trim().split("\n").length, 1 + 1200);
  } finally {
    await app.close();
  }
});
