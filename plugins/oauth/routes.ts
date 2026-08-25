import * as nodeCrypto from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { getConfig } from "../../src/config/index.js";
import { getDb } from "../../src/db/index.js";
import { oauthExchangeCodesTable, usersTable } from "../../src/db/schema/index.js";
import { getLogger } from "../../src/logger/index.js";
import { randomToken } from "../../src/shared/randomToken.js";
import { setRefreshTokenCookie } from "../../src/shared/authCookies.js";
import { authMiddleware } from "../../src/middleware/auth.js";
import { sensitiveReverification } from "../../src/middleware/continuousVerification.js";
import { rateLimit } from "../../src/middleware/rateLimiting.js";
import { recordAndRespond } from "../../src/services/auth/accountTakeover.service.js";
import { issueAuthenticatedSession } from "../../src/services/auth/issueAuthenticatedSession.service.js";
import { getClientIp } from "../../src/shared/clientIp.js";
import { internalError } from "../../src/shared/httpErrors.js";
import { appRedirectUrl } from "../../src/shared/safeRedirect.js";
import type { HonoEnv, OAuthProvider } from "../../src/shared/types.js";
import {
  buildAuthorizationUrl,
  isSupportedProvider,
  PROVIDER_META,
} from "./authorize-url.js";
import { getProviderAdapter } from "./provider.factory.js";
import type { AppleUserInfo } from "./providers/apple.js";
import { generateOAuthState, getAndVerifyOAuthState, OAUTH_STATE_TTL_SECS } from "./state.js";

const router = new Hono<HonoEnv>();
const logger = getLogger("oauth-routes");

// POST /oauth/state
router.post("/oauth/state", rateLimit({ points: 20, windowSecs: 60 }), async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { codeChallenge?: string };
  const state = await generateOAuthState(body.codeChallenge);
  return c.json({ state, ttlSeconds: OAUTH_STATE_TTL_SECS });
});

// GET /oauth/:provider/authorize
router.get("/oauth/:provider/authorize", rateLimit({ points: 20, windowSecs: 60 }), async (c) => {
  const provider = c.req.param("provider");
  if (!isSupportedProvider(provider)) {
    return c.json(
      {
        error: "UNSUPPORTED_PROVIDER",
        message: `Provider '${provider}' is not supported`,
      },
      400
    );
  }

  const cfg = getConfig();
  const p = cfg.oauth.providers[provider];
  if (!p?.clientId || !p?.clientSecret || !p?.redirectUri) {
    return c.json(
      {
        error: "PROVIDER_NOT_CONFIGURED",
        message: `Provider '${provider}' is not configured`,
      },
      400
    );
  }

  let codeChallenge: string | undefined;
  let codeVerifier: string | undefined;
  if (PROVIDER_META[provider].supportsPKCE) {
    codeVerifier = nodeCrypto.randomBytes(32).toString("base64url");
    codeChallenge = nodeCrypto.createHash("sha256").update(codeVerifier).digest("base64url");
  }

  const state = await generateOAuthState(codeChallenge, codeVerifier);
  const authorizeUrl = buildAuthorizationUrl(provider, {
    clientId: p.clientId,
    redirectUri: p.redirectUri,
    state,
    codeChallenge,
  });

  return c.json({ authorizeUrl, state });
});

// GET /oauth/:provider/callback
router.get("/oauth/:provider/callback", rateLimit({ points: 20, windowSecs: 60 }), async (c) => {
  try {
    const provider = c.req.param("provider");
    const code = c.req.query("code");
    const state = c.req.query("state");

    if (!code) {
      return c.json({ error: "INVALID_REQUEST", message: "code is required" }, 400);
    }
    const stateResult = await getAndVerifyOAuthState(state);
    if (!stateResult.ok) {
      return c.json({ error: "INVALID_STATE", message: "Invalid or expired state" }, 400);
    }

    let codeVerifier: string | null = null;
    if (stateResult.codeChallenge) {
      codeVerifier = stateResult.codeVerifier;
      if (!codeVerifier) {
        return c.json({ error: "PKCE_REQUIRED", message: "code_verifier is required" }, 400);
      }
      const { createHash } = await import("node:crypto");
      const challenge = createHash("sha256").update(codeVerifier).digest("base64url");
      if (challenge !== stateResult.codeChallenge) {
        return c.json({ error: "PKCE_MISMATCH", message: "Invalid code_verifier" }, 400);
      }
    }

    const adapter = getProviderAdapter(provider);
    let appleUserInfo: AppleUserInfo | undefined;
    if (provider === "apple") {
      const userParam = c.req.query("user");
      if (userParam) {
        try {
          appleUserInfo = JSON.parse(userParam) as AppleUserInfo;
        } catch {
          logger.warn("Malformed Apple user payload on callback", { provider });
        }
      }
    }

    let result: Awaited<ReturnType<typeof adapter.exchangeCode>>;
    try {
      result = await adapter.exchangeCode(code, codeVerifier ?? undefined, appleUserInfo);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("UNSUPPORTED_OAUTH_PROVIDER")) {
        return c.json(
          {
            error: "UNSUPPORTED_PROVIDER",
            message: `Provider '${provider}' is not supported`,
          },
          501
        );
      }
      throw err;
    }
    if (!result?.profile) {
      return c.json(
        {
          error: "PROVIDER_ERROR",
          message: "Provider token exchange failed",
        },
        502
      );
    }

    const profile: { email?: string; emails?: Array<{ value: string }>; id?: string | number; name?: string; emailVerified?: boolean } =
      result.profile;
    const rawEmail = profile.email || profile.emails?.[0]?.value;
    if (!rawEmail) {
      return c.json({ error: "NO_EMAIL", message: "Provider did not return email" }, 400);
    }
    const email = String(rawEmail).toLowerCase().trim();
    const providerId = profile.id != null ? String(profile.id) : undefined;
    const link = { provider, providerId, email, connectedAt: new Date() };

    const db = getDb();
    const userRows = await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);
    let user = userRows[0];

    if (!user) {
      const [created] = await db
        .insert(usersTable)
        .values({
          email,
          displayName: profile.name || email.split("@")[0],
          roles: ["user"],
          oauthProviders: [link],
          emailVerifiedAt: profile.emailVerified ? new Date() : null,
          status: "active",
        })
        .returning();
      user = created;
    } else {
      const providers = (user.oauthProviders as OAuthProvider[] | null) || [];
      const has = providers.some((p) => p.provider === provider && p.providerId === providerId);
      if (!has) {
        if (profile.emailVerified !== true) {
          return c.json(
            {
              error: "OAUTH_EMAIL_UNVERIFIED",
              message:
                `An account already exists for this email. Sign in with your existing method, ` +
                `then link ${provider} from account settings. (${provider} did not return a ` +
                `verified email, so we can't merge the accounts automatically.)`,
            },
            403
          );
        }
        await db
          .update(usersTable)
          .set({
            oauthProviders: [...providers, link],
            updatedAt: new Date(),
          })
          .where(eq(usersTable.id, user.id));
      }
    }

    const { body, sessionId, refreshTokenPlain } = await issueAuthenticatedSession(c, user);

    const exchangeCode = randomToken(32);
    const EXCHANGE_CODE_TTL_SECS = 60;
    await db.insert(oauthExchangeCodesTable).values({
      code: exchangeCode,
      userId: user.id,
      sessionId,
      accessToken: body.accessToken,
      refreshToken: refreshTokenPlain,
      expiresAt: new Date(Date.now() + EXCHANGE_CODE_TTL_SECS * 1000),
    });

    return c.redirect(appRedirectUrl(`/login?oauth_code=${exchangeCode}`), 302);
  } catch (err) {
    logger.error("OAuth callback error", err as Error);
    return c.redirect(
      appRedirectUrl(
        `/login?error=OAUTH_FAILED&message=${encodeURIComponent("OAuth callback failed")}`
      ),
      302
    );
  }
});

// POST /oauth/exchange
router.post("/oauth/exchange", rateLimit({ points: 10, windowSecs: 60 }), async (c) => {
  try {
    const { code } = await c.req.json().catch(() => ({}));
    if (!code || typeof code !== "string") {
      return c.json({ error: "INVALID_REQUEST", message: "code is required" }, 400);
    }

    const db = getDb();
    // Atomically claim the code: the UPDATE only matches an unused, unexpired
    // row, so two concurrent exchanges of the same code can never both succeed
    // (the loser's WHERE finds no row). Read-then-update would leave a race
    // window where a leaked code is redeemed twice.
    const [row] = await db
      .update(oauthExchangeCodesTable)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(oauthExchangeCodesTable.code, code),
          sql`${oauthExchangeCodesTable.usedAt} IS NULL`,
          sql`${oauthExchangeCodesTable.expiresAt} > now()`
        )
      )
      .returning();

    if (!row) {
      return c.json({ error: "INVALID_CODE", message: "Invalid or expired code" }, 400);
    }

    const cfg = getConfig();
    setRefreshTokenCookie(c, row.refreshToken, cfg.session.refreshTokenTTL);

    return c.json({
      accessToken: row.accessToken,
    });
  } catch (err) {
    return internalError(c, logger, "OAuth exchange error", err, "Token exchange failed");
  }
});

// DELETE /oauth/:provider — unlink a connected OAuth account
router.delete("/oauth/:provider", authMiddleware, sensitiveReverification, async (c) => {
  try {
    const user = c.get("user");
    const provider = c.req.param("provider");

    const db = getDb();
    const [row] = await db
      .select({
        passwordHash: usersTable.passwordHash,
        oauthProviders: usersTable.oauthProviders,
      })
      .from(usersTable)
      .where(eq(usersTable.id, user.id))
      .limit(1);
    if (!row) return c.json({ error: "USER_NOT_FOUND", message: "User not found" }, 404);

    const providers = (row.oauthProviders as OAuthProvider[] | null) ?? [];
    const linked = providers.some((p) => p.provider === provider);
    if (!linked) {
      return c.json({ error: "NOT_LINKED", message: `No ${provider} account is linked` }, 404);
    }

    const hasPassword = Boolean(row.passwordHash);
    if (!hasPassword && providers.length <= 1) {
      return c.json(
        {
          error: "LAST_CREDENTIAL",
          message:
            "Set a password before disconnecting your only sign-in method, or you'll be locked out.",
        },
        409
      );
    }

    const remaining = providers.filter((p) => p.provider !== provider);
    await db
      .update(usersTable)
      .set({ oauthProviders: remaining, updatedAt: new Date() })
      .where(eq(usersTable.id, user.id));

    void recordAndRespond(user.id, "oauth_unlink", {
      email: user.email,
      displayName: user.displayName ?? user.email,
      ipAddress: getClientIp(c),
      userAgent: c.req.header("user-agent"),
    });

    return c.json({ unlinked: true, provider });
  } catch (err) {
    return internalError(c, logger, "OAuth unlink error", err, "Failed to disconnect account");
  }
});

// POST /me/link — link an OAuth identity to the current account
router.post("/me/link", authMiddleware, rateLimit({ points: 10, windowSecs: 60 }), async (c) => {
  try {
    const user = c.get("user");
    const { provider, code, codeVerifier } = await c.req.json().catch(() => ({}));

    if (!provider || !code) {
      return c.json(
        {
          error: "INVALID_REQUEST",
          message: "provider and code are required",
        },
        400
      );
    }

    if (!isSupportedProvider(provider)) {
      return c.json(
        {
          error: "INVALID_REQUEST",
          message: `Unsupported provider '${provider}'`,
        },
        400
      );
    }

    const adapter = getProviderAdapter(provider);
    let result: Awaited<ReturnType<typeof adapter.exchangeCode>>;
    try {
      result = await adapter.exchangeCode(code, codeVerifier ?? undefined);
    } catch (err) {
      logger.warn("OAuth link code exchange failed", {
        provider,
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json(
        { error: "PROVIDER_ERROR", message: "Could not verify the OAuth authorization" },
        502
      );
    }

    const profile: { id?: string | number; email?: string; emailVerified?: boolean } | null =
      result?.profile;
    const providerUserId = profile?.id != null ? String(profile.id) : undefined;
    if (!profile || !providerUserId) {
      return c.json(
        { error: "PROVIDER_ERROR", message: "Provider did not return an identity" },
        502
      );
    }
    if (profile.emailVerified !== true) {
      return c.json(
        {
          error: "OAUTH_EMAIL_UNVERIFIED",
          message: `${provider} did not return a verified email; cannot link this identity.`,
        },
        403
      );
    }

    const db = getDb();

    const [existingLink] = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(
        and(
          eq(usersTable.status, "active"),
          sql`${usersTable.oauthProviders} @> ${JSON.stringify([{ provider, providerId: providerUserId }])}::jsonb`
        )
      )
      .limit(1);

    if (existingLink && existingLink.id !== user.id) {
      return c.json(
        {
          error: "ALREADY_LINKED",
          message: "This OAuth account is already linked to another user",
        },
        409
      );
    }

    const [currentUser] = await db
      .select({ oauthProviders: usersTable.oauthProviders })
      .from(usersTable)
      .where(eq(usersTable.id, user.id))
      .limit(1);

    const providers = (currentUser?.oauthProviders as OAuthProvider[] | null) ?? [];
    if (providers.some((p) => p.provider === provider && p.providerId === providerUserId)) {
      return c.json({ linked: true, provider, alreadyLinked: true });
    }

    const newProvider = {
      provider,
      providerId: providerUserId,
      email: profile.email ?? null,
      connectedAt: new Date(),
    };

    await db
      .update(usersTable)
      .set({
        oauthProviders: [...providers, newProvider],
        updatedAt: new Date(),
      })
      .where(eq(usersTable.id, user.id));

    logger.info("OAuth provider linked", { userId: user.id, provider });
    return c.json({ linked: true, provider });
  } catch (err) {
    return internalError(c, logger, "Account link error", err, "Failed to link account");
  }
});

export default router;
