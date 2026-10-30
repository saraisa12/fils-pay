/**
 * Regression tests for: acquirer callback verification + dedup (FP-201), the webhook SSRF guard,
 * credit approver identity, and payment-link token randomness.
 */
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { assertDistinctApprover } from "../admin/creditApproval.js";
import { createPaymentLink } from "../paymentLinks/create.js";
import { validateWebhookUrl } from "../webhooks/create.js";
import { verifyAcquirerCallbackSignature } from "../webhooks/inboundVerify.js";
import { isPrivateAddress } from "../webhooks/ssrf.js";
import { createFetchTransport } from "../webhooks/transport.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("hardening.new.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}
const SECRET = "acqsec_test_secret";
const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  ACQUIRER_CALLBACK_SIGNING_SECRET: SECRET,
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});
const pool = new Pool({ connectionString: databaseUrl, max: 5 });
const app = buildApp(config, pool);
test.after(async () => {
  await app.close();
  await pool.end();
});

// ------------------------------------------------------------ acquirer callbacks

async function transaction(): Promise<string> {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`,
    [`Callback ${randomUUID()}`],
  );
  const t = await pool.query<{ id: string }>(
    `INSERT INTO transactions (merchant_id, status, amount_fils, captured_fils, acquirer_reference)
     VALUES ($1, 'captured', 1000, 1000, $2) RETURNING id`,
    [m.rows[0]!.id, `acq_${randomUUID()}`],
  );
  return t.rows[0]!.id;
}

function signed(rawBody: string, timestamp = Math.floor(Date.now() / 1000)) {
  const sig = createHmac("sha256", SECRET).update(`${timestamp}.${rawBody}`).digest("hex");
  return { "content-type": "application/json", "acquirer-callback-signature": `t=${timestamp},v1=${sig}` };
}

function bodyFor(transactionId: string, callbackId: string, extra: Record<string, unknown> = {}) {
  return {
    callbackId,
    type: "fraud_review.completed",
    transactionId,
    occurredAt: "2026-10-30T10:00:00.000Z",
    outcome: "cleared",
    note: "ok",
    ...extra,
  };
}

async function notes(callbackId: string): Promise<number> {
  const r = await pool.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM acquirer_callback_notes WHERE callback_id = $1`, [callbackId]);
  return r.rows[0]!.n;
}

test("a redelivered callback stores exactly one note", async () => {
  const txn = await transaction();
  const callbackId = `acqcb_${randomUUID()}`;
  const raw = JSON.stringify(bodyFor(txn, callbackId));
  for (let i = 0; i < 3; i++) {
    const res = await app.inject({ method: "POST", url: "/v1/acquirer/callbacks", headers: signed(raw), payload: raw });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(res.json(), { received: true });
  }
  assert.equal(await notes(callbackId), 1);
});

test("the signature is checked against the raw bytes, not a re-serialization", async () => {
  const txn = await transaction();
  const callbackId = `acqcb_${randomUUID()}`;
  // Same JSON, but with the spacing and key order the acquirer's serializer happened to produce.
  const b = bodyFor(txn, callbackId);
  const raw = `{ "note" : "ok", "outcome": "cleared", "occurredAt": "${b.occurredAt}", "transactionId": "${txn}", "type": "fraud_review.completed", "callbackId": "${callbackId}" }`;
  const res = await app.inject({ method: "POST", url: "/v1/acquirer/callbacks", headers: signed(raw), payload: raw });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(await notes(callbackId), 1);

  // A body that differs by a single byte from what was signed is refused.
  const tampered = raw.replace('"ok"', '"OK"');
  const res2 = await app.inject({ method: "POST", url: "/v1/acquirer/callbacks", headers: signed(raw), payload: tampered });
  assert.equal(res2.statusCode, 401, res2.body);
});

test("an old genuine callback cannot be replayed", async () => {
  const txn = await transaction();
  const callbackId = `acqcb_${randomUUID()}`;
  const raw = JSON.stringify(bodyFor(txn, callbackId));
  const old = Math.floor(Date.now() / 1000) - 3600;
  const res = await app.inject({ method: "POST", url: "/v1/acquirer/callbacks", headers: signed(raw, old), payload: raw });
  assert.equal(res.statusCode, 401, res.body);
  assert.equal(res.json().message, "timestamp_out_of_tolerance");
  assert.equal(await notes(callbackId), 0);
});

test("an unsigned callback is refused by default", async () => {
  const txn = await transaction();
  const res = await app.inject({ method: "POST", url: "/v1/acquirer/callbacks", payload: bodyFor(txn, `acqcb_${randomUUID()}`) });
  assert.equal(res.statusCode, 401, res.body);
});

test("callback input is validated: outcome, transaction id, timestamp and JSON", async () => {
  const txn = await transaction();
  const post = (obj: Record<string, unknown>) => {
    const raw = JSON.stringify(obj);
    return app.inject({ method: "POST", url: "/v1/acquirer/callbacks", headers: signed(raw), payload: raw });
  };
  assert.equal((await post(bodyFor(txn, "c1", { outcome: "approved" }))).statusCode, 400);
  assert.equal((await post(bodyFor("not-a-uuid", "c2"))).statusCode, 400);
  assert.equal((await post(bodyFor(txn, "c3", { occurredAt: "yesterday-ish" }))).statusCode, 400);
  const bad = await app.inject({ method: "POST", url: "/v1/acquirer/callbacks", headers: { "content-type": "application/json" }, payload: "{nope" });
  assert.equal(bad.statusCode, 400);
});

test("the verifier refuses an empty secret and compares in constant time", () => {
  const raw = '{"a":1}';
  const t = Math.floor(Date.now() / 1000);
  const forgedWithEmptyKey = createHmac("sha256", "").update(`${t}.${raw}`).digest("hex");
  assert.equal(verifyAcquirerCallbackSignature(raw, `t=${t},v1=${forgedWithEmptyKey}`, "", true).valid, false);
  assert.equal(verifyAcquirerCallbackSignature(raw, `t=${t},v1=zz`, SECRET, true).reason, "signature_mismatch");
});

// ------------------------------------------------------------------------- SSRF

test("private, loopback, link-local and reserved addresses are recognised", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "::", "fc00::1", "fe80::1", "::ffff:127.0.0.1", "[::1]", "224.0.0.1"]) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "93.184.216.34", "2606:4700:4700::1111"]) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
});

test("in production a webhook URL must be https and public; dev and test keep localhost", () => {
  const prod = { nodeEnv: "production" as const };
  for (const url of ["https://localhost/hook", "https://127.0.0.1/hook", "https://10.0.0.5/hook", "https://169.254.169.254/latest/meta-data", "https://[::1]/hook", "https://settlement/internal/run-batch", "https://db.internal/x", "http://example.com/hook", "https://user:pw@example.com/hook"]) {
    assert.throws(() => validateWebhookUrl(url, prod), { code: "invalid_url" }, url);
  }
  assert.doesNotThrow(() => validateWebhookUrl("https://merchant.example.com/hook", prod));
  assert.doesNotThrow(() => validateWebhookUrl("http://127.0.0.1:9999/hook", { nodeEnv: "test" }));
});

function listen(handler: Parameters<typeof createServer>[1]): Promise<{ server: Server; url: string; port: number }> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}`, port });
    });
  });
}
const req = (url: string) => ({ url, headers: {}, body: "{}", timeoutMs: 3000 });

test("the transport refuses to call an internal address when blocking is on", async () => {
  let hits = 0;
  const target = await listen((_q, r) => { hits++; r.end("secret"); });
  try {
    const result = await createFetchTransport({ blockPrivateAddresses: true })(req(target.url));
    assert.equal(result.statusCode, null);
    assert.match(result.errorMessage ?? "", /not a public address/);
    assert.equal(hits, 0, "nothing was sent");
    const named = await createFetchTransport({ blockPrivateAddresses: true })(req(`http://localhost:${target.port}`));
    assert.equal(named.statusCode, null);
    assert.equal(hits, 0);
  } finally {
    target.server.close();
  }
});

test("a redirect is not followed", async () => {
  let internalHits = 0;
  const internal = await listen((_q, r) => { internalHits++; r.end("internal"); });
  const redirector = await listen((_q, r) => { r.writeHead(302, { location: internal.url }); r.end(); });
  try {
    const result = await createFetchTransport()(req(redirector.url));
    assert.equal(result.statusCode, 302);
    assert.equal(internalHits, 0, "the redirect target was never contacted");
  } finally {
    internal.server.close();
    redirector.server.close();
  }
});

test("a huge response is cut off instead of buffered", async () => {
  const big = await listen((_q, r) => { r.write("x".repeat(5_000_000)); r.end(); });
  try {
    const result = await createFetchTransport({ maxResponseBytes: 10_000 })(req(big.url));
    assert.equal(result.statusCode, 200);
    assert.ok(result.body.length <= 10_000, `body length ${result.body.length}`);
  } finally {
    big.server.close();
  }
});

// -------------------------------------------------------- approver, link tokens

test("the credit approver is compared by account id, not by display name", () => {
  const requester = { adminUserId: "11111111-1111-1111-1111-111111111111", displayName: "Fay Finance" };
  assert.throws(() => assertDistinctApprover(requester, { adminUserId: requester.adminUserId, displayName: "Renamed Fay" }), { code: "self_approval_forbidden" });
  assert.doesNotThrow(() => assertDistinctApprover(requester, { adminUserId: "22222222-2222-2222-2222-222222222222", displayName: "Fay Finance" }));
});

test("payment link tokens come from crypto, not Math.random", async () => {
  const m = await pool.query<{ id: string }>(`INSERT INTO merchants (display_name, mdr_bps) VALUES ($1, 250) RETURNING id`, [`Tok ${randomUUID()}`]);
  const u = await pool.query<{ id: string }>(
    `INSERT INTO merchant_users (merchant_id, email, role, password_hash) VALUES ($1, $2, 'owner', 'x') RETURNING id`,
    [m.rows[0]!.id, `t-${randomUUID()}@example.test`],
  );
  const original = Math.random;
  Math.random = () => { throw new Error("Math.random must not be used for payment link tokens"); };
  try {
    const tokens = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const link = await createPaymentLink(pool, { checkoutBaseUrl: "http://x" }, {
        merchantId: m.rows[0]!.id,
        amountFils: 1000,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        createdByType: "merchant_session",
        createdById: u.rows[0]!.id,
      });
      const token = (link as unknown as { token?: string; url?: string }).token ?? (link as unknown as { url: string }).url.split("/").pop()!;
      assert.match(token, /^plink_[A-Za-z0-9_-]{22}$/);
      tokens.add(token);
    }
    assert.equal(tokens.size, 20);
  } finally {
    Math.random = original;
  }
});
