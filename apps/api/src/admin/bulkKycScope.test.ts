/** B015: bulk KYC approve skips merchants that aren't waiting for review and records a review per approval. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { Pool } from "pg";
import { bulkApproveMerchantsKyc } from "./bulkKyc.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("bulkKycScope.test.ts requires DATABASE_URL");
const pool = new Pool({ connectionString: databaseUrl, max: 3 });
after(async () => pool.end());

async function merchant(status: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps, onboarding_status) VALUES ($1, 250, $2) RETURNING id`,
    [`bulk-kyc-${randomUUID()}`, status],
  );
  return r.rows[0]!.id;
}

test("B015: only under_review merchants are approved, each with a review row", async () => {
  const admin = await pool.query<{ id: string }>(
    `INSERT INTO admin_users (email, password_hash, display_name, role) VALUES ($1, 'x', 'Bulk KYC Test', 'finance') RETURNING id`,
    [`bulk-kyc-${randomUUID()}@admin.test`],
  );
  const pending = await merchant("under_review");
  const rejected = await merchant("rejected");

  const result = await bulkApproveMerchantsKyc(pool, { merchantIds: [pending, rejected], adminUserId: admin.rows[0]!.id });

  assert.deepEqual(result.approvedMerchantIds, [pending]);
  const rows = await pool.query<{ id: string; onboarding_status: string }>(
    `SELECT id, onboarding_status FROM merchants WHERE id = ANY($1)`,
    [[pending, rejected]],
  );
  const status = Object.fromEntries(rows.rows.map((r) => [r.id, r.onboarding_status]));
  assert.equal(status[pending], "approved");
  assert.equal(status[rejected], "rejected", "a rejected merchant must not be approved by a bulk action");
  const reviews = await pool.query(`SELECT 1 FROM merchant_kyc_reviews WHERE merchant_id = $1 AND reviewer_admin_user_id = $2`, [
    pending,
    admin.rows[0]!.id,
  ]);
  assert.equal(reviews.rowCount, 1, "each bulk approval must leave a review row");
});
