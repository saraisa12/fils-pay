/**
 * Refunds (FP-300) through the real HTTP routes, against a real migrated
 * Postgres. Covers the bugs the first helper draft had: refunding more than
 * was captured, two refunds at once both paying out, refunding another
 * merchant's transaction, and fee reversal that did not add back up.
 */
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { issueApiKey } from "../apiKeys/issue.js";
import { recordKycReview } from "../onboarding/review.js";
import { createWebhookEndpoint } from "../webhooks/create.js";
import { runDispatchPass } from "../webhooks/dispatcher.js";
import { verifySignature } from "../webhooks/sign.js";
import type { WebhookTransportRequest } from "../webhooks/transport.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("refunds.new.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  INTERNAL_API_TOKEN: "test-internal-token",
  ACQUIRER_FAILURE_RATE: "0",
  ACQUIRER_LATENCY_MIN_MS: "20",
  ACQUIRER_LATENCY_MAX_MS: "30",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});
const pool = new Pool({ connectionString: databaseUrl, max: 10 });
const app = buildApp(config, pool);

test.after(async () => {
  await app.close();
  await pool.end();
});

const VALID_CARD = { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" };

async function merchantWithKey(label: string, mdrBps = 250) {
  const merchant = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, $2) RETURNING id`,
    [`Refund Route ${label} ${randomUUID()}`, mdrBps],
  );
  const merchantId = merchant.rows[0]!.id;
  const user = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash)
     VALUES ($1, $2, 'owner', 'unused') RETURNING id`,
    [merchantId, `o-${randomUUID()}@example.test`],
  );
  await recordKycReview(pool, { merchantId, outcome: "approved", reviewerIdentifier: "test" });
  const issued = await issueApiKey(pool, config, { merchantId, createdBy: user.rows[0]!.id, label });
  return { merchantId, rawKey: issued.rawKey };
}

async function capturedTransaction(rawKey: string, amountFils: number, captureFils?: number): Promise<string> {
  const auth = await app.inject({
    method: "POST",
    url: "/v1/transactions",
    headers: { authorization: `Bearer ${rawKey}`, "idempotency-key": randomUUID() },
    payload: { amountFils, card: VALID_CARD },
  });
  assert.equal(auth.statusCode, 201, auth.body);
  const id = (auth.json() as { id: string }).id;
  const cap = await app.inject({
    method: "POST",
    url: `/v1/transactions/${id}/capture`,
    headers: { authorization: `Bearer ${rawKey}`, "idempotency-key": randomUUID() },
    payload: captureFils === undefined ? {} : { amountFils: captureFils },
  });
  assert.equal(cap.statusCode, 200, cap.body);
  return id;
}

function refund(rawKey: string, merchantId: string, body: Record<string, unknown>, key: string | null = randomUUID()) {
  const headers: Record<string, string> = { authorization: `Bearer ${rawKey}` };
  if (key) headers["idempotency-key"] = key;
  return app.inject({ method: "POST", url: `/v1/merchants/${merchantId}/refunds`, headers, payload: body });
}

test("a refund can never exceed what was captured (not what was authorized)", async () => {
  const m = await merchantWithKey("ceiling");
  const txn = await capturedTransaction(m.rawKey, 10_000, 4_000); // captured 4.000 of a 10.000 authorization

  const tooMuch = await refund(m.rawKey, m.merchantId, { transactionId: txn, amountFils: 5_000 });
  assert.equal(tooMuch.statusCode, 422, tooMuch.body);
  assert.equal(tooMuch.json().error, "refund_exceeds_refundable");
  assert.equal(tooMuch.json().code, "refund_exceeds_refundable");
  assert.equal(tooMuch.json().refundableFils, 4_000);

  const all = await refund(m.rawKey, m.merchantId, { transactionId: txn });
  assert.equal(all.statusCode, 200, all.body);
  assert.equal(all.json().amountFils, 4_000);
  assert.equal(all.json().transactionStatus, "refunded", "every captured fil went back");

  const again = await refund(m.rawKey, m.merchantId, { transactionId: txn, amountFils: 1 });
  assert.equal(again.statusCode, 409, "nothing left to refund");
});

test("two refunds fired at the same time cannot both pay out", async () => {
  const m = await merchantWithKey("race");
  const txn = await capturedTransaction(m.rawKey, 10_000);

  const results = await Promise.all([
    refund(m.rawKey, m.merchantId, { transactionId: txn, amountFils: 7_000 }),
    refund(m.rawKey, m.merchantId, { transactionId: txn, amountFils: 7_000 }),
  ]);
  const codes = results.map((r) => r.statusCode).sort();
  assert.deepEqual(codes, [200, 422], results.map((r) => r.body).join(" | "));

  const row = await pool.query<{ refunded_fils: string }>(`SELECT refunded_fils FROM transactions WHERE id = $1`, [txn]);
  assert.equal(Number(row.rows[0]!.refunded_fils), 7_000);
  const count = await pool.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM refunds WHERE transaction_id = $1`, [txn]);
  assert.equal(count.rows[0]!.n, 1);
});

test("another merchant's transaction is a 404 and nothing is refunded", async () => {
  const owner = await merchantWithKey("owner");
  const attacker = await merchantWithKey("attacker");
  const txn = await capturedTransaction(owner.rawKey, 5_000);

  const res = await refund(attacker.rawKey, attacker.merchantId, { transactionId: txn });
  assert.equal(res.statusCode, 404, res.body);

  const viaAlias = await app.inject({
    method: "POST",
    url: "/v1/refunds",
    headers: { authorization: `Bearer ${attacker.rawKey}`, "idempotency-key": randomUUID() },
    payload: { transactionId: txn },
  });
  assert.equal(viaAlias.statusCode, 404, viaAlias.body);

  // Naming the victim in the path is refused outright.
  const wrongPath = await refund(attacker.rawKey, owner.merchantId, { transactionId: txn });
  assert.equal(wrongPath.statusCode, 403, wrongPath.body);

  const row = await pool.query<{ refunded_fils: string; status: string }>(
    `SELECT refunded_fils, status FROM transactions WHERE id = $1`,
    [txn],
  );
  assert.equal(Number(row.rows[0]!.refunded_fils), 0);
  assert.equal(row.rows[0]!.status, "captured");
});

test("partial refunds reverse exactly the fee that was charged, no more and no less", async () => {
  const m = await merchantWithKey("fee-sum", 250);
  const txn = await capturedTransaction(m.rawKey, 10_000); // fee 250
  let reversed = 0;
  for (const amount of [3_333, 3_333, 3_334]) {
    const res = await refund(m.rawKey, m.merchantId, { transactionId: txn, amountFils: amount });
    assert.equal(res.statusCode, 200, res.body);
    reversed += res.json().feeReversedFils;
  }
  assert.equal(reversed, 250);

  const net = await pool.query<{ net: string }>(
    `SELECT SUM(CASE WHEN direction = 'credit' THEN amount_fils ELSE -amount_fils END)::text AS net
       FROM ledger_entries WHERE transaction_id = $1 AND account_id = 'platform_fee_revenue'`,
    [txn],
  );
  assert.equal(Number(net.rows[0]!.net), 0, "platform fee revenue for a fully refunded sale nets to zero");
});

test("the Idempotency-Key header is required and bad input is a 400, never a 500", async () => {
  const m = await merchantWithKey("validation");
  const txn = await capturedTransaction(m.rawKey, 2_000);

  assert.equal((await refund(m.rawKey, m.merchantId, { transactionId: txn }, null)).statusCode, 400);
  assert.equal((await refund(m.rawKey, m.merchantId, { transactionId: "not-a-uuid" })).statusCode, 400);
  assert.equal((await refund(m.rawKey, m.merchantId, { transactionId: txn, amountFils: 1.5 })).statusCode, 400);
  assert.equal((await refund(m.rawKey, m.merchantId, { transactionId: txn, amountFils: -5 })).statusCode, 400);
  const noAuth = await app.inject({ method: "POST", url: "/v1/refunds", payload: { transactionId: txn } });
  assert.equal(noAuth.statusCode, 401);
});

test("the shop gets a refund.succeeded webhook whose signature verifies against the exact bytes sent", async () => {
  const m = await merchantWithKey("webhook");
  const endpoint = await createWebhookEndpoint(pool, config, {
    merchantId: m.merchantId,
    url: "https://merchant.example.test/hook",
    createdByType: "merchant_api_key",
    createdById: randomUUID(),
  });
  const txn = await capturedTransaction(m.rawKey, 6_000);
  const res = await refund(m.rawKey, m.merchantId, { transactionId: txn, amountFils: 2_000 });
  assert.equal(res.statusCode, 200, res.body);

  const sent: WebhookTransportRequest[] = [];
  const transport = async (req: WebhookTransportRequest) => {
    sent.push(req);
    return { statusCode: 200, body: "ok" };
  };
  await runDispatchPass(pool, transport, config);

  const refundHook = sent.find((r) => (JSON.parse(r.body) as { type: string }).type === "refund.succeeded");
  assert.ok(refundHook, "a refund.succeeded delivery was sent");
  const body = JSON.parse(refundHook.body) as { data: Record<string, unknown> };
  assert.equal(body.data.transactionId, txn);
  assert.equal(body.data.amountFils, 2_000);
  assert.equal(body.data.refundedTotalFils, 2_000);
  assert.equal(body.data.status, "partially_refunded");

  // Merchants verify the HMAC over `${t}.${rawBody}` using the bytes they received.
  const header = refundHook.headers["Webhook-Signature"]!;
  const t = /t=(\d+)/.exec(header)![1]!;
  const expected = createHmac("sha256", endpoint.secret).update(`${t}.${refundHook.body}`).digest("hex");
  assert.equal(header, `t=${t},v1=${expected}`);
  assert.equal(verifySignature(JSON.parse(refundHook.body), header, endpoint.secret).valid, true);
});
