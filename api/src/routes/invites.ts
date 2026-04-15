import { Hono } from "hono";
import type { AppEnv } from "../types.js";
import { createInvite } from "../db/entities.js";

export const invites = new Hono<AppEnv>();

// POST /api/v1/invites — generate an invite link for the calling user.
// shareTemplates defaults to true; caller can opt out.
invites.post("/", async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{ shareTemplates?: boolean }>().catch(() => ({} as { shareTemplates?: boolean }));
  const shareTemplates = body.shareTemplates !== false;

  const { code, expiresAt } = await createInvite(user.userId, shareTemplates);
  return c.json({ code, expiresAt });
});
