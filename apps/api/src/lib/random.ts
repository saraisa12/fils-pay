import { randomInt } from "node:crypto";

/** Generates a string of `n` random decimal digits (e.g. "042817").
 *  B003: used for OTP login codes, so it must be unpredictable. Math.random
 *  is not crypto-safe (its output can be predicted); crypto.randomInt is. */
export function randomDigits(n: number): string {
  return randomInt(0, 10 ** n)
    .toString()
    .padStart(n, "0");
}

/** Generates a string of `n` characters drawn uniformly from `alphabet`. */
export function randomFromAlphabet(alphabet: string, n: number): string {
  let out = "";
  for (let i = 0; i < n; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

/** Short display-only reference for receipts and logs (e.g. "FP-A7K2M3"). */
export function displayReference(): string {
  return `FP-${randomFromAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 6)}`;
}
