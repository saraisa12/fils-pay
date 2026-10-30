/**
 * Regression tests for four access-control holes, against a real migrated Postgres:
 *  - a merchant could cancel another merchant's payment link,
 *  - /v1/reporting/export-summary needed no login,
 *  - any merchant could read a split child's report by naming it,
 *  - a support admin could create (and auto-post) credits.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { issueApiKey } from "../apiKeys/issue.js";
import { recordKycReview } from "../onboarding/review.js";
import { hashPassword } from "../adminAuth/passwords.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("security_fixes.new.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  OTP_DEV_EXPOSE: "true",
  SETTLEMENT_INTERNAL_TOKEN: "test-settlement-token",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});
const pool = new Pool({ connectionString: databaseUrl, max: 5 });
const app = buildApp(config, pool);

test.after(async () => {
  await app.close();
  await pool.end();
});

async function merchantWithKey(label: string) {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Sec ${label} ${randomUUID()}`],
  );
  const merchantId = m.rows[0]!.id;
  const u = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash)
     VALUES ($1, $2, 'owner', 'unused') RETURNING id`,
    [merchantId, `o-${randomUUID()}@example.test`],
  );
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  const issued = await issueApiKey(pool, config, { merchantId, createdBy: u.rows[0]!.id, label });
  return { merchantId, auth: { authorization: `Bearer ${issued.rawKey}` } };
}

test("a merchant cannot cancel another merchant's payment link", async () => {
  const victim = await merchantWithKey("victim");
  const attacker = await merchantWithKey("attacker");
  const created = await app.inject({
    method: "POST",
    url: `/v1/merchants/${victim.merchantId}/payment-links`,
    headers: victim.auth,
    payload: { amountFils: 5_000, expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
  });
  assert.equal(created.statusCode, 201, created.body);
  const linkId = (created.json() as { id: string }).id;

  // Using the attacker's own path (passes the path check) with the victim's link id:
  const res = await app.inject({
    method: "DELETE",
    url: `/v1/merchants/${attacker.merchantId}/payment-links/${linkId}`,
    headers: attacker.auth,
  });
  assert.equal(res.statusCode, 404, res.body);

  const row = await pool.query<{ status: string }>(`SELECT status FROM payment_links WHERE id = $1`, [linkId]);
  assert.equal(row.rows[0]!.status, "active", "the victim's link is untouched");

  // The owner can still cancel it.
  const own = await app.inject({
    method: "DELETE",
    url: `/v1/merchants/${victim.merchantId}/payment-links/${linkId}`,
    headers: victim.auth,
  });
  assert.equal(own.statusCode, 204, own.body);
});

test("/v1/reporting/export-summary needs authentication", async () => {
  const anon = await app.inject({ method: "GET", url: "/v1/reporting/export-summary" });
  assert.equal(anon.statusCode, 401, anon.body);

  const m = await merchantWithKey("summary");
  const ok = await app.inject({ method: "GET", url: "/v1/reporting/export-summary", headers: m.auth });
  assert.equal(ok.statusCode, 200, ok.body);
});

test("only the PARENT of a split child can read the child's transactions report", async () => {
  const parent = await merchantWithKey("parent");
  const child = await merchantWithKey("child");
  const stranger = await merchantWithKey("stranger");
  await pool.query(
    `INSERT INTO merchant_split_children (parent_merchant_id, child_merchant_id, split_weight_bps)
     VALUES ($1, $2, 10000)`,
    [parent.merchantId, child.merchantId],
  );
  await pool.query(
    `INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, acquirer_reference, reference)
     VALUES ($1, 'captured', 7000, 7000, $2, 'child-secret-sale')`,
    [child.merchantId, `acq_${randomUUID()}`],
  );
  const filter = encodeURIComponent(JSON.stringify({ merchantId: child.merchantId }));

  const asStranger = await app.inject({
    method: "GET",
    url: `/v1/reporting/transactions?filter=${filter}`,
    headers: stranger.auth,
  });
  assert.equal(asStranger.statusCode, 200, asStranger.body);
  assert.deepEqual(asStranger.json(), [], "a stranger gets their own (empty) report, never the child's");

  const asParent = await app.inject({
    method: "GET",
    url: `/v1/reporting/transactions?filter=${filter}`,
    headers: parent.auth,
  });
  const rows = asParent.json() as Array<{ reference: string }>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.reference, "child-secret-sale");
});

test("a support admin cannot create a credit; finance can", async () => {
  const hash = await hashPassword("admin-test-password-9000!", config);
  async function admin(role: "support" | "finance") {
    const email = `${role}-${randomUUID()}@admin.test`;
    await pool.query(
      `INSERT INTO admin_users (email, password_hash, display_name, role) VALUES ($1, $2, $3, $4)`,
      [email, hash, `${role} ${randomUUID().slice(0, 8)}`, role],
    );
    const login = await app.inject({
      method: "POST",
      url: "/v1/admin/auth/login",
      payload: { email, password: "admin-test-password-9000!" },
    });
    const cookieHeader = login.headers["set-cookie"];
    const cookie = (Array.isArray(cookieHeader) ? cookieHeader[0]! : cookieHeader!).split(";")[0]!;
    const verify = await app.inject({
      method: "POST",
      url: "/v1/admin/auth/otp/verify",
      headers: { cookie },
      payload: { code: (login.json() as { devOtpCode: string }).devOtpCode },
    });
    assert.equal(verify.statusCode, 200, verify.body);
    return cookie;
  }
  const merchant = await merchantWithKey("credit-target");
  const payload = {
    baseAmountFils: 1_000,
    reasonCode: "goodwill",
    effectiveDate: new Date().toISOString().slice(0, 10),
  };

  const support = await app.inject({
    method: "POST",
    url: `/v1/admin/merchants/${merchant.merchantId}/credits`,
    headers: { cookie: await admin("support") },
    payload,
  });
  assert.equal(support.statusCode, 403, support.body);
  const posted = await pool.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM credit_requests WHERE merchant_id = $1`,
    [merchant.merchantId],
  );
  assert.equal(posted.rows[0]!.n, 0, "nothing was created or posted");

  const finance = await app.inject({
    method: "POST",
    url: `/v1/admin/merchants/${merchant.merchantId}/credits`,
    headers: { cookie: await admin("finance") },
    payload,
  });
  assert.equal(finance.statusCode, 201, finance.body);
});
