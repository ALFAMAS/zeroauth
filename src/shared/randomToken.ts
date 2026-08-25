import { randomBytes } from "node:crypto";

/**
 * URL-safe random token, replacing the `nanoid` dependency with the
 * `node:crypto` (Bun-native) primitive the CWE-327 rule already mandates for
 * tokens. `length` is the number of base64url characters returned; entropy
 * scales at ~6 bits/char, matching nanoid's default alphabet size.
 */
export function randomToken(length = 21): string {
  const bytes = Math.ceil((length * 3) / 4);
  return randomBytes(bytes).toString("base64url").slice(0, length);
}
