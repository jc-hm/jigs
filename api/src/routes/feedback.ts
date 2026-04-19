import { Hono } from "hono";
import { putFeedback } from "../db/entities.js";
import { log } from "../lib/log.js";
import type { AppEnv } from "../types.js";

const feedback = new Hono<AppEnv>();

feedback.post("/", async (c) => {
  const user = c.get("user");
  const requestId = c.get("requestId");

  const body = await c.req.json<{
    type?: string;
    content?: string;
    rating?: string;
    context?: { page?: string; requestId?: string; action?: string };
  }>();

  const { type, content, rating, context } = body ?? {};

  if (type !== "contact" && type !== "reaction" && type !== "bug") {
    return c.json({ error: "type must be contact, reaction, or bug" }, 400);
  }
  if (type === "reaction" && rating !== "up" && rating !== "down") {
    return c.json({ error: "rating must be up or down for reaction type" }, 400);
  }
  if (content && content.length > 2000) {
    return c.json({ error: "content too long" }, 400);
  }

  const id = crypto.randomUUID();
  await putFeedback({
    id,
    type,
    createdAt: new Date().toISOString(),
    ...(content && { content: content.trim() }),
    ...(rating === "up" || rating === "down" ? { rating } : {}),
    ...(context && { context }),
    userId: user.userId,
    orgId: user.orgId,
  });

  log.info("feedback.submit", { requestId, userId: user.userId, type, id });
  return c.json({ ok: true });
});

export { feedback };
