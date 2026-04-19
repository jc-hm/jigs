import { Hono } from "hono";
import { checkRateLimit, putFeedback, putWaitlist } from "../db/entities.js";
import { log } from "../lib/log.js";

const publicRoutes = new Hono();

function clientIp(req: Request): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown"
  );
}

publicRoutes.post("/feedback", async (c) => {
  const ip = clientIp(c.req.raw);
  const { allowed } = await checkRateLimit(`ip:${ip}:feedback`, 3, 3600);
  if (!allowed) return c.json({ error: "Too many requests" }, 429);

  const body = await c.req.json<{
    content?: string;
    senderEmail?: string;
    senderName?: string;
    context?: { page?: string };
  }>();

  const { content, senderEmail, senderName, context } = body ?? {};

  if (!content || typeof content !== "string" || content.trim().length === 0) {
    return c.json({ error: "content is required" }, 400);
  }
  if (
    !senderEmail ||
    typeof senderEmail !== "string" ||
    !senderEmail.includes("@")
  ) {
    return c.json({ error: "valid senderEmail is required" }, 400);
  }
  if (content.length > 2000) {
    return c.json({ error: "content too long" }, 400);
  }

  const id = crypto.randomUUID();
  await putFeedback({
    id,
    type: "contact",
    createdAt: new Date().toISOString(),
    content: content.trim(),
    senderEmail: senderEmail.toLowerCase().trim(),
    ...(senderName && { senderName: senderName.trim() }),
    ...(context && { context }),
  });

  log.info("public.feedback", { id, page: context?.page });
  return c.json({ ok: true });
});

publicRoutes.post("/waitlist", async (c) => {
  const ip = clientIp(c.req.raw);
  const { allowed } = await checkRateLimit(`ip:${ip}:waitlist`, 3, 3600);
  if (!allowed) return c.json({ error: "Too many requests" }, 429);

  const body = await c.req.json<{ email?: string; note?: string }>();
  const { email, note } = body ?? {};

  if (!email || typeof email !== "string" || !email.includes("@")) {
    return c.json({ error: "valid email is required" }, 400);
  }
  if (note && note.length > 500) {
    return c.json({ error: "note too long" }, 400);
  }

  try {
    await putWaitlist(email.trim(), note?.trim());
  } catch (e: unknown) {
    // Already on waitlist — treat as success (idempotent)
    if (e instanceof Error && e.name === "ConditionalCheckFailedException") {
      return c.json({ ok: true });
    }
    throw e;
  }

  log.info("public.waitlist", { email: email.toLowerCase().trim() });
  return c.json({ ok: true });
});

export { publicRoutes };
