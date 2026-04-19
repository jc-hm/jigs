import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { authMiddleware } from "./middleware/auth.js";
import { superAdminOnly } from "./middleware/super-admin.js";
import { fill } from "./routes/fill.js";
import { templates } from "./routes/templates.js";
import { billing } from "./routes/billing.js";
import { invites } from "./routes/invites.js";
import { admin } from "./routes/admin.js";
import { publicRoutes } from "./routes/public.js";
import { feedback } from "./routes/feedback.js";
import { config } from "./env.js";
import { log } from "./lib/log.js";
import type { AppEnv } from "./types.js";

const app = new Hono<AppEnv>();

// --- Global middleware ---
app.use("*", cors());

// Per-request UUID. Stored on context so every downstream log line — and
// the cost-tracking record in TrackedBedrock — share the same id, making
// CloudWatch grep ("requestId = X") and per-request investigation trivial.
// Generated up-front (before auth) so 401s and 4xx errors are also tagged.
app.use("*", async (c, next) => {
  c.set("requestId", crypto.randomUUID());
  await next();
});

app.use("*", logger());

// --- Public endpoints (no auth) ---
app.get("/api/health", (c) => c.json({ status: "ok" }));

app.get("/api/config", (c) => {
  if (config.isLocal) {
    return c.json({ auth: null });
  }
  return c.json({
    auth: {
      userPoolId: config.cognitoUserPoolId,
      clientId: config.cognitoClientId,
      region: config.region,
    },
  });
});

// Public invite validation — registered before auth middleware so no token needed.
app.get("/api/invites/:code", async (c) => {
  const { getInvite } = await import("./db/entities.js");
  const code = c.req.param("code");
  const invite = await getInvite(code);
  if (!invite) return c.json({ valid: false });
  return c.json({ valid: true, expiresAt: invite.expiresAt });
});

// --- Public routes (no auth) ---
app.route("/api/public/v1", publicRoutes);

// --- Protected routes ---
app.use("/api/*", authMiddleware);
app.route("/api/v1/fill", fill);
app.route("/api/v1/templates", templates);
app.route("/api/v1/billing", billing);
app.route("/api/v1/invites", invites);
app.route("/api/v1/feedback", feedback);

// Super admin routes — requires valid Cognito JWT + pinned cognitoId match
app.use("/api/v1/admin/*", superAdminOnly);
app.route("/api/v1/admin", admin);

// --- Global error handler ---
// Hono's default 500 handler swallows the stack — that's why our prior
// staging 500s were silent in CloudWatch. This handler captures the full
// error with route + user context so every uncaught exception is greppable
// by requestId.
//
// Bedrock retryable errors (ThrottlingException, ServiceUnavailableException,
// ModelStreamErrorException) are translated to 503 with a Retry-After hint
// so the frontend can show "AI is busy, try again in a moment" rather than
// a scary generic error. Note: the SDK retries internally up to maxAttempts
// (configured to 8 in adaptive mode in tracked-bedrock.ts), so by the time
// these surface here, retries have already been exhausted.
const RETRYABLE_BEDROCK_ERRORS = new Set([
  "ThrottlingException",
  "ServiceUnavailableException",
  "ModelStreamErrorException",
  "ModelTimeoutException",
]);

app.onError((err, c) => {
  const user = c.get("user");
  const isRetryable =
    err instanceof Error && RETRYABLE_BEDROCK_ERRORS.has(err.name);

  log.error("request.unhandled_error", err, {
    requestId: c.get("requestId"),
    route: `${c.req.method} ${c.req.path}`,
    userId: user?.userId,
    orgId: user?.orgId,
    retryable: isRetryable,
  });

  if (isRetryable) {
    c.header("Retry-After", "5");
    return c.json(
      {
        error:
          "The AI service is temporarily busy. Please try again in a few seconds.",
        retryable: true,
      },
      503,
    );
  }

  return c.json({ error: "Internal server error" }, 500);
});

export { app };
