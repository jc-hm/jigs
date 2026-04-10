import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { authMiddleware } from "./middleware/auth.js";
import { fill } from "./routes/fill.js";
import { templates } from "./routes/templates.js";
import { billing } from "./routes/billing.js";
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

// --- Protected routes ---
app.use("/api/*", authMiddleware);
app.route("/api/v1/fill", fill);
app.route("/api/v1/templates", templates);
app.route("/api/v1/billing", billing);

// --- Global error handler ---
// Hono's default 500 handler swallows the stack — that's why our prior
// staging 500s were silent in CloudWatch. This handler captures the full
// error with route + user context so every uncaught exception is greppable
// by requestId.
app.onError((err, c) => {
  const user = c.get("user");
  log.error("request.unhandled_error", err, {
    requestId: c.get("requestId"),
    route: `${c.req.method} ${c.req.path}`,
    userId: user?.userId,
    orgId: user?.orgId,
  });
  return c.json({ error: "Internal server error" }, 500);
});

export { app };
