import { Hono } from "hono";
import { getDailyUsage, getMonthlyUsage, getOrgBalance } from "../db/entities.js";
import type { AppEnv } from "../types.js";

const billing = new Hono<AppEnv>();

// Get current user's usage + org balance
billing.get("/usage", async (c) => {
  const user = c.get("user");

  const [daily, monthly, balance] = await Promise.all([
    getDailyUsage(user.userId),
    getMonthlyUsage(`USER#${user.userId}`),
    getOrgBalance(user.orgId),
  ]);

  return c.json({
    daily: { reportCount: daily },
    monthly,
    balance,
  });
});

// Get org-wide usage (admin only)
billing.get("/usage/org", async (c) => {
  const user = c.get("user");
  if (user.role !== "admin") {
    return c.json({ error: "Admin only" }, 403);
  }

  const [monthly, balance] = await Promise.all([
    getMonthlyUsage(`ORG#${user.orgId}`),
    getOrgBalance(user.orgId),
  ]);
  return c.json({ monthly, balance });
});

export { billing };
