import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { Pool } from "pg";
import { withTransaction } from "../db/withTransaction.js";
import { applyEvent, type OutboxEventRow } from "./applyEvent.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("refund.new.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}
const pool = new Pool({ connectionString: databaseUrl, max: 3 });
after(async () => {
  await pool.end();
});

async function createMerchant(): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Refund Rollup ${randomUUID()}`],
  );
  return r.rows[0]!.id;
}

function refundRow(merchantId: string, amountFils: number, createdAt: Date): OutboxEventRow {
  return {
    id: 1,
    event_type: "refund.succeeded",
    aggregate_id: randomUUID(),
    created_at: createdAt,
    payload: { merchantId, refundId: randomUUID(), amountFils, feeReversedFils: 0, refundedTotalFils: amountFils, newStatus: "refunded" },
  };
}

test("refund.succeeded counts on the Asia/Bahrain day, not the UTC day", async () => {
  const merchantId = await createMerchant();
  // 22:30 UTC on the 5th is 01:30 on the 6th in Bahrain.
  await withTransaction(pool, (c) => applyEvent(c, refundRow(merchantId, 1_500, new Date("2026-01-05T22:30:00Z"))));
  await withTransaction(pool, (c) => applyEvent(c, refundRow(merchantId, 500, new Date("2026-01-06T10:00:00Z"))));

  const rows = await pool.query<{ volume_date: Date; refund_count: number; refund_gross_fils: string }>(
    `SELECT volume_date::text AS volume_date, refund_count, refund_gross_fils
       FROM merchant_daily_volume WHERE merchant_id = $1`,
    [merchantId],
  );
  assert.equal(rows.rows.length, 1, "both refunds landed on the same Bahrain day");
  assert.equal(rows.rows[0]!.volume_date, "2026-01-06");
  assert.equal(rows.rows[0]!.refund_count, 2);
  assert.equal(Number(rows.rows[0]!.refund_gross_fils), 2_000);
});
