import { randomToken } from "../../src/shared/randomToken.js";

export const OAUTH_STATE_TTL_SECS = 300;

const oauthStateStore = new Map<
  string,
  { ts: number; codeChallenge?: string | null; codeVerifier?: string | null }
>();
const OAUTH_STATE_MAX_SIZE = 10_000;

const oauthStateCleanupInterval = setInterval(() => {
  const cutoff = Date.now() - OAUTH_STATE_TTL_SECS * 1000;
  for (const [key, entry] of oauthStateStore) {
    if (entry.ts < cutoff) oauthStateStore.delete(key);
  }
}, 60_000);
if (oauthStateCleanupInterval.unref) oauthStateCleanupInterval.unref();

export async function getAndVerifyOAuthState(state?: string): Promise<{
  ok: boolean;
  codeChallenge: string | null;
  codeVerifier: string | null;
}> {
  if (!state) return { ok: false, codeChallenge: null, codeVerifier: null };
  try {
    const { getRedis } = await import("../../src/services/shared/rateLimiter/redis.js");
    const redis = getRedis();
    if (redis) {
      const raw = await redis.get(`oauth:state:${state}`);
      if (!raw) return { ok: false, codeChallenge: null, codeVerifier: null };
      await redis.del(`oauth:state:${state}`);
      const parsed = JSON.parse(raw);
      if (Date.now() - parsed.ts > OAUTH_STATE_TTL_SECS * 1000)
        return { ok: false, codeChallenge: null, codeVerifier: null };
      return {
        ok: true,
        codeChallenge: parsed.codeChallenge || null,
        codeVerifier: parsed.codeVerifier || null,
      };
    }
  } catch {
    // Redis not available, fall through to memory
  }

  const entry = oauthStateStore.get(state);
  if (!entry) return { ok: false, codeChallenge: null, codeVerifier: null };
  if (Date.now() - entry.ts > OAUTH_STATE_TTL_SECS * 1000) {
    oauthStateStore.delete(state);
    return { ok: false, codeChallenge: null, codeVerifier: null };
  }
  const challenge = entry.codeChallenge || null;
  const verifier = entry.codeVerifier || null;
  oauthStateStore.delete(state);
  return { ok: true, codeChallenge: challenge, codeVerifier: verifier };
}

export async function generateOAuthState(
  codeChallenge?: string,
  codeVerifier?: string
): Promise<string> {
  const state = randomToken();
  const store = JSON.stringify({
    ts: Date.now(),
    codeChallenge: codeChallenge || null,
    codeVerifier: codeVerifier || null,
  });
  try {
    const { getRedis } = await import("../../src/services/shared/rateLimiter/redis.js");
    const redis = getRedis();
    if (redis) {
      await redis.setex(`oauth:state:${state}`, OAUTH_STATE_TTL_SECS, store);
      return state;
    }
  } catch {
    // Redis not available, fall through to memory
  }

  if (oauthStateStore.size >= OAUTH_STATE_MAX_SIZE) {
    const entries = [...oauthStateStore.entries()].sort((a, b) => a[1].ts - b[1].ts);
    const evictCount = Math.floor(OAUTH_STATE_MAX_SIZE * 0.25);
    for (let i = 0; i < evictCount; i++) oauthStateStore.delete(entries[i][0]);
  }
  oauthStateStore.set(state, JSON.parse(store));
  return state;
}
