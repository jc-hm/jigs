import { Hono } from "hono";
import { getOrgBalance } from "../db/entities.js";
import type { AppEnv } from "../types.js";

const billing = new Hono<AppEnv>();

// Get current user's usage + org balance
billing.get("/usage", async (c) => {
  const user = c.get("user");

  const balance = await getOrgBalance(user.orgId);
  return c.json({ balance });
});

// Get org-wide usage (admin only)
billing.get("/usage/org", async (c) => {
  const user = c.get("user");
  if (user.role !== "admin") {
    return c.json({ error: "Admin only" }, 403);
  }

  const balance = await getOrgBalance(user.orgId);
  return c.json({ balance });
});

export { billing };
