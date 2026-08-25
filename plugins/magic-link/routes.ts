import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { Hono } from "hono";
import { getConfig } from "../../src/config/index.js";
import { getDb } from "../../src/db/index.js";
import {
  oauthExchangeCodesTable,
  refreshTokensTable,
  sessionsTable,
  usersTable,
} from "../../src/db/schema/index.js";
import { getLogger } from "../../src/logger/index.js";
import { captchaGuard } from "../../src/middleware/captcha.js";
import { rateLimit } from "../../src/middleware/rateLimiting.js";
import { getSettings } from "../../src/services/shared/saasSettings.service.js";
import { sendMagicLink, verifyMagicLink } from "../../src/services/auth/magicLink.service.js";
import { TokenService } from "../../src/services/auth/token.service.js";
import { getClientIp } from "../../src/shared/clientIp.js";
import { internalError } from "../../src/shared/httpErrors.js";
import { randomToken } from "../../src/shared/randomToken.js";
import { appRedirectUrl, safeRelativeRedirect } from "../../src/shared/safeRedirect.js";
import type { HonoEnv } from "../../src/shared/types.js";

const router = new Hono<HonoEnv>();
const logger = getLogger("magic-link-routes");

let _tokenService: TokenService | null = null;
async function getTokenService(): Promise<TokenService> {
  if (_tokenService) return _tokenService;
  const cfg = getConfig();
  _tokenService = new TokenService(cfg.security.tokenSecretHex, cfg.session);
  await _tokenService.init();
  return _tokenService;
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

async function issueTokensForUser(userId: string, c: Context<HonoEnv>) {
  const cfg = getConfig();
  const tokenSvc = await getTokenService();
  const db = getDb();

  const userRows = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  const user = userRows[0];
  if (!user) throw new Error("User not found");

  const sessionId = crypto.randomUUID();
  const accessToken = await tokenSvc.signAccessToken({
    sub: user.id,
    email: user.email,
    sid: sessionId,
    aud: "zerotrust",
    scope: ["openid"],
  });
  const payload = await tokenSvc.verifyAccessToken(accessToken);

  const ip = getClientIp(c);
  const userAgent = c.req.header("user-agent") || "";

  const [session] = await db
    .insert(sessionsTable)
    .values({
      id: sessionId,
      userId: user.id,
      tokenId: payload.jti,
      deviceFingerprint: {},
      ipAddress: ip,
      userAgent,
      expiresAt: new Date(payload.exp * 1000),
      lastActivityAt: new Date(),
      isActive: true,
    })
    .returning();

  const refreshTokenPlain = await tokenSvc.signRefreshToken();
  await db.insert(refreshTokensTable).values({
    userId: user.id,
    sessionId: session.id,
    tokenHash: hashToken(refreshTokenPlain),
    familyId: crypto.randomUUID(),
    expiresAt: new Date(Date.now() + cfg.session.refreshTokenTTL * 1000),
  });

  return {
    accessToken,
    refreshToken: refreshTokenPlain,
    sessionId: session.id,
    expiresIn: cfg.session.defaultTTL,
  };
}

router.post("/send", rateLimit({ points: 5, windowSecs: 60 }), captchaGuard(), async (c) => {
  try {
    const settings = await getSettings();
    if (!settings.magicLinkEnabled) {
      return c.json({ error: "FEATURE_DISABLED", message: "Magic link is disabled" }, 403);
    }

    const { email, redirectUrl } = await c.req.json();
    if (!email) {
      return c.json({ error: "INVALID_REQUEST", message: "email is required" }, 400);
    }

    await sendMagicLink(email, redirectUrl);
    return c.json({ sent: true });
  } catch (err) {
    logger.error("Magic link send error", err as Error);
    return c.json({ sent: true });
  }
});

router.get("/verify", async (c) => {
  try {
    const settings = await getSettings();
    if (!settings.magicLinkEnabled) {
      return c.json({ error: "FEATURE_DISABLED", message: "Magic link is disabled" }, 403);
    }

    const email = c.req.query("email");
    const token = c.req.query("token");
    const redirect = c.req.query("redirect");

    if (!email || !token) {
      return c.json({ error: "INVALID_REQUEST", message: "email and token required" }, 400);
    }

    const result = await verifyMagicLink(email, token);
    if (!result) {
      return c.json({ error: "INVALID_TOKEN", message: "Invalid or expired magic link" }, 401);
    }

    const tokens = await issueTokensForUser(result.userId, c);

    const appUrl = settings.appUrl || "http://localhost:3000";
    const safePath = safeRelativeRedirect(redirect, "/auth/callback");
    const exchangeCode = randomToken(32);
    const EXCHANGE_CODE_TTL_SECS = 60;
    await getDb()
      .insert(oauthExchangeCodesTable)
      .values({
        code: exchangeCode,
        userId: result.userId,
        sessionId: tokens.sessionId,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: new Date(Date.now() + EXCHANGE_CODE_TTL_SECS * 1000),
      });

    const callbackUrl = appRedirectUrl(`${safePath}?oauth_code=${exchangeCode}`, appUrl);
    return c.redirect(callbackUrl, 302);
  } catch (err) {
    return internalError(c, logger, "Magic link GET verify error", err, "Verification failed");
  }
});

router.post("/verify", async (c) => {
  try {
    const settings = await getSettings();
    if (!settings.magicLinkEnabled) {
      return c.json({ error: "FEATURE_DISABLED", message: "Magic link is disabled" }, 403);
    }

    const { email, token } = await c.req.json();
    if (!email || !token) {
      return c.json({ error: "INVALID_REQUEST", message: "email and token required" }, 400);
    }

    const result = await verifyMagicLink(email, token);
    if (!result) {
      return c.json({ error: "INVALID_TOKEN", message: "Invalid or expired magic link" }, 401);
    }

    const tokens = await issueTokensForUser(result.userId, c);
    return c.json(tokens);
  } catch (err) {
    return internalError(c, logger, "Magic link POST verify error", err, "Verification failed");
  }
});

export default router;
