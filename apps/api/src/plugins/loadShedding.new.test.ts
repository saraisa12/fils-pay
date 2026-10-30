/**
 * Load shedding: above the in-flight limit the money routes answer 503 + Retry-After at once, health
 * checks and reads are never shed, and capacity comes back when requests finish.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("loadShedding.new.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  MAX_INFLIGHT_PAYMENTS: "2",
  ACQUIRER_FAILURE_RATE: "0",
  ACQUIRER_LATENCY_MIN_MS: "300",
  ACQUIRER_LATENCY_MAX_MS: "300",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});
const pool = new Pool({ connectionString: databaseUrl, max: 10 });
const app = buildApp(config, pool);
test.after(async () => {
  await app.close();
  await pool.end();
});

const CARD = { pan: "4242424242424242", expiryMonth: 12, expiryYear: 2030, cvv: "123" };

async function links(n: number): Promise<string[]> {
  const m = await pool.query<{ id: string }>(
    `INSERT INTO merchants (display_name, mdr_bps, onboarding_status) VALUES ($1, 250, 'approved') RETURNING id`,
    [`Shed ${randomUUID()}`],
  );
  const tokens: string[] = [];
  for (let i = 0; i < n; i++) {
    const token = `plink_shed_${randomUUID()}`;
    await pool.query(
      `INSERT INTO payment_links (merchant_id, token, amount_fils, expires_at, created_by_type, created_by_id)
       VALUES ($1, $2, 5000, now() + interval '1 hour', 'merchant_session', gen_random_uuid())`,
      [m.rows[0]!.id, token],
    );
    tokens.push(token);
  }
  return tokens;
}

const pay = (token: string) =>
  app.inject({
    method: "POST",
    url: `/v1/payment-links/${token}/pay`,
    headers: { "idempotency-key": randomUUID() },
    payload: { card: CARD },
  });

test("above the limit extra checkouts get an immediate 503 + Retry-After; the rest succeed", async () => {
  const tokens = await links(6);
  const started = Date.now();
  const results = await Promise.all(tokens.map((t) => pay(t)));
  const ok = results.filter((r) => r.statusCode === 200);
  const shed = results.filter((r) => r.statusCode === 503);

  assert.equal(ok.length + shed.length, 6, results.map((r) => r.statusCode).join(","));
  assert.equal(ok.length, 2, "only the in-flight limit is served at once");
  assert.equal(shed.length, 4);
  for (const r of shed) {
    assert.equal(r.headers["retry-after"], "1");
    assert.equal((r.json() as { error: string }).error, "overloaded");
  }
  assert.equal(app.inflightPayments(), 0, "every slot is released");

  // The shed links were never touched: they can still be paid, and the request is safe to retry.
  const retried = await pay(tokens[results.findIndex((r) => r.statusCode === 503)]!);
  assert.equal(retried.statusCode, 200, retried.body);
  assert.ok(Date.now() - started < 5000);
});

test("health checks are never shed, even while the money routes are full", async () => {
  const tokens = await links(4);
  const inFlight = tokens.map((t) => pay(t));
  await new Promise((r) => setTimeout(r, 50));
  const health = await app.inject({ method: "GET", url: "/healthz" });
  assert.equal(health.statusCode, 200);
  assert.ok(app.inflightPayments() >= 1);
  await Promise.all(inFlight);
  assert.equal(app.inflightPayments(), 0);
});
