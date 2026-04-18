import type { Context, Next } from "hono";

export async function superAdminOnly(c: Context, next: Next) {
  if (!c.get("user")?.superAdmin) return c.json({ error: "Forbidden" }, 403);
  return next();
}
