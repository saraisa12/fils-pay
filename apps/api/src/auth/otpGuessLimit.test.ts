/**
 * B004 / B005: the OTP guess limit (otpMaxAttempts) must hold even when
 * guesses are sent in parallel, and a resend must not reset it.
 * Requires DATABASE_URL to point at a real, migrated Postgres.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("otpGuessLimit.test.ts requires DATABASE_URL to point at a real, migrated Postgres");
}

const config = loadConfig({
  DATABASE_URL: databaseUrl,
  NODE_ENV: "test",
  OTP_DEV_EXPOSE: "true",
  INTERNAL_API_TOKEN: "test-internal-token",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
});

const pool = new Pool({ connectionString: databaseUrl, max: 10 });
const app = buildApp(config, pool);

test.after(async () => {
  await app.close();
  await pool.end();
});

/** Creates a merchant user, logs in with the password, returns the pending cookie and real code. */
async function loginPending(): Promise<{ cookie: string; code: string }> {
  const email = `otp-limit-${randomUUID()}@example.test`;
  const password = "correct horse battery staple 1!";
  const signup = await app.inject({
    method: "POST",
    url: "/v1/merchants",
    payload: {
      businessProfile: {
        legalName: `OTP Limit Co ${randomUUID()}`,
        registrationNumber: `RC-${randomUUID().slice(0, 8)}`,
        businessType: "llc",
        contactEmail: email,
        contactPhone: "+97300000000",
        addressLine1: "1 Test Street",
        city: "Manama",
      },
      owner: { email, password },
    },
  });
  assert.equal(signup.statusCode, 201, signup.body);
  const { merchantId } = signup.json() as { merchantId: string };

  const login = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { merchantId, email, password } });
  assert.equal(login.statusCode, 200, login.body);
  const header = login.headers["set-cookie"];
  const cookie = (Array.isArray(header) ? header[0] : header)!.split(";")[0]!;
  return { cookie, code: (login.json() as { devOtpCode: string }).devOtpCode };
}

function wrongCode(code: string): string {
  return code === "000000" ? "111111" : "000000";
}

function guess(cookie: string, code: string) {
  return app.inject({ method: "POST", url: "/v1/auth/otp/verify", headers: { cookie }, payload: { code } });
}

test("B004: 20 parallel wrong guesses get at most otpMaxAttempts checks", async () => {
  const { cookie, code } = await loginPending();

  const responses = await Promise.all(Array.from({ length: 20 }, () => guess(cookie, wrongCode(code))));
  const checked = responses.filter((r) => r.statusCode === 401 && r.json().error === "invalid_code").length;

  assert.ok(
    checked <= config.otpMaxAttempts,
    `${checked} guesses were checked against the code, limit is ${config.otpMaxAttempts}`,
  );
});

test("B005: a resend keeps the guesses already used", async () => {
  const { cookie, code } = await loginPending();

  // Use all but one guess.
  for (let i = 0; i < config.otpMaxAttempts - 1; i++) {
    const r = await guess(cookie, wrongCode(code));
    assert.equal(r.json().error, "invalid_code");
  }

  // Skip the 30s resend throttle, then resend.
  await pool.query(
    `UPDATE otp_challenges SET created_at = now() - interval '1 minute'
      WHERE id = (SELECT otp_challenge_id FROM sessions WHERE token_hash = encode(sha256($1::bytea), 'hex'))`,
    [cookie.split("=")[1]],
  );
  const resend = await app.inject({ method: "POST", url: "/v1/auth/otp/resend", headers: { cookie } });
  assert.equal(resend.statusCode, 200, resend.body);

  // One guess left, not a fresh budget.
  const last = await guess(cookie, "999999");
  assert.equal(last.json().error, "invalid_code");
  const blocked = await guess(cookie, "999998");
  assert.equal(blocked.statusCode, 429, "resend gave a fresh set of guesses");
});
