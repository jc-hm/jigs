import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { authMiddleware } from "./middleware/auth.js";
import { fill } from "./routes/fill.js";
import { skills } from "./routes/skills.js";
import { templates } from "./routes/templates.js";
import { billing } from "./routes/billing.js";
import type { AppEnv } from "./types.js";

const app = new Hono<AppEnv>();

// Global middleware
app.use("*", cors());
app.use("*", logger());

// Health check (no auth)
app.get("/api/health", (c) => c.json({ status: "ok" }));

// Protected routes
app.use("/api/*", authMiddleware);

// Routes
app.route("/api/v1/fill", fill);
app.route("/api/v1/skills", skills);
app.route("/api/v1/templates", templates);
app.route("/api/v1/billing", billing);

export { app };
