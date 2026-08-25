/**
 * Access tokens are spec-compliant PASETO v4.local tokens
 * (XChaCha20 + keyed BLAKE2b with PAE), implemented in ../crypto/paseto-v4.ts
 * and validated against the official paseto-standard test vectors.
 *
 * Refresh tokens are opaque random strings (not PASETO) — they carry no claims
 * and are looked up server-side.
 */

import { decrypt, encrypt, PasetoError } from "../../crypto/paseto-v4";
import { randomToken } from "../../shared/randomToken";
import type { TokenPayload, zerotrustConfig } from "../../shared/types";
import { DEFAULT_ACCESS_TOKEN_TTL } from "../../shared/types";

export class TokenService {
  private key!: Uint8Array;
  private config: zerotrustConfig["session"] & { secretKeyHex: string };

  constructor(secretKeyHex: string, sessionConfig: zerotrustConfig["session"]) {
    this.config = { ...sessionConfig, secretKeyHex };
  }

  // Kept async for call-site compatibility; v4.local needs no key import step.
  async init() {
    const keyBytes = this.hexToBytes(this.config.secretKeyHex);
    if (keyBytes.length !== 32) {
      throw new Error("TOKEN_SECRET_INVALID: expected a 32-byte (64 hex char) key");
    }
    this.key = keyBytes;
  }

  async signAccessToken(
    payload: Omit<TokenPayload, "iat" | "exp" | "jti">,
    ttl = DEFAULT_ACCESS_TOKEN_TTL
  ): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const full: TokenPayload = {
      ...payload,
      jti: randomToken(),
      iat: now,
      exp: now + ttl,
    };
    return encrypt(this.key, new TextEncoder().encode(JSON.stringify(full)));
  }

  async signRefreshToken(): Promise<string> {
    const bytes = crypto.getRandomValues(new Uint8Array(48));
    return this.bytesToHex(bytes);
  }

  async verifyAccessToken(token: string): Promise<TokenPayload> {
    let raw: string;
    try {
      raw = new TextDecoder().decode(decrypt(this.key, token));
    } catch (err) {
      // Normalize all PASETO-level failures to the existing public error code.
      if (err instanceof PasetoError) throw new Error("TOKEN_INVALID");
      throw err;
    }
    let payload: TokenPayload;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new Error("TOKEN_INVALID");
    }
    if (payload === null || typeof payload !== "object" || typeof payload.exp !== "number") {
      throw new Error("TOKEN_INVALID");
    }
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp < now) throw new Error("TOKEN_EXPIRED");
    return payload;
  }

  private hexToBytes(hex: string): Uint8Array {
    const result = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
      result[i / 2] = parseInt(hex.substr(i, 2), 16);
    }
    return result;
  }

  private bytesToHex(bytes: Uint8Array): string {
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
}
