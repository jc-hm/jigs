import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { authMiddleware } from "./middleware/auth.js";
import { fill } from "./routes/fill.js";
import { templates } from "./routes/templates.js";
import { billing } from "./routes/billing.js";
import { config } from "./env.js";
import type { AppEnv } from "./types.js";

const app = new Hono<AppEnv>();

// Global middleware
app.use("*", cors());
app.use("*", logger());

// Public endpoints (no auth)
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

// Protected routes
app.use("/api/*", authMiddleware);

// Routes
app.route("/api/v1/fill", fill);
app.route("/api/v1/templates", templates);
app.route("/api/v1/billing", billing);

export { app };
