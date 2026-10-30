/** B006: the OTP code is only put in the login response when OTP_DEV_EXPOSE is set. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "./config.js";

const base = {
  DATABASE_URL: "postgres://unused",
  WEBHOOK_SECRET_ENCRYPTION_KEY: "Y1ZTGTcYbe30GZJebys9w7T3OYZNKewuOH3SUCEdRQk=",
};

test("B006: NODE_ENV unset does not expose the OTP code", () => {
  assert.equal(loadConfig({ ...base }).otpDevExpose, false);
});

test("B006: OTP_DEV_EXPOSE=true still turns it on for local dev and tests", () => {
  assert.equal(loadConfig({ ...base, OTP_DEV_EXPOSE: "true" }).otpDevExpose, true);
});
