import { Hono } from "hono";
import { getDailyUsage, getMonthlyUsage } from "../db/entities.js";
import type { AppEnv } from "../types.js";

const billing = new Hono<AppEnv>();

// Get current user's usage
billing.get("/usage", async (c) => {
  const user = c.get("user");

  const [daily, monthly] = await Promise.all([
    getDailyUsage(user.userId),
    getMonthlyUsage(`USER#${user.userId}`),
  ]);

  return c.json({
    daily: { reportCount: daily },
    monthly,
  });
});

// Get org-wide usage (admin only)
billing.get("/usage/org", async (c) => {
  const user = c.get("user");
  if (user.role !== "admin") {
    return c.json({ error: "Admin only" }, 403);
  }

  const monthly = await getMonthlyUsage(`ORG#${user.orgId}`);
  return c.json({ monthly });
});

export { billing };
