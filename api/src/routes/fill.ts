import { Hono } from "hono";
import { stream } from "hono/streaming";
import { getAIRouter, getAIFiller } from "../services/ai/provider.js";
import { lsRecursive, cat, findAuthor } from "../services/files/operations.js";
import { checkFreeLimit, InsufficientBalanceError } from "../services/billing/tracker.js";
import { TrackedBedrock } from "../services/billing/tracked-bedrock.js";
import { config } from "../env.js";
import type { AppEnv } from "../types.js";

const fill = new Hono<AppEnv>();

fill.post("/", async (c) => {
  const user = c.get("user");

  const body = await c.req.json<{
    message: string;
    sessionContext?: string;
    conversationHistory?: Array<{ role: "user" | "assistant"; text: string }>;
  }>();

  // Check free tier (skipped in local dev). This is the legacy daily-report
  // limit; once topups are wired and new users get a starter credit, this
  // can be retired in favour of the balance gate inside TrackedBedrock.
  if (!config.isLocal) {
    const allowed = await checkFreeLimit(user.userId);
    if (!allowed) {
      return c.json(
        { error: "Daily free limit reached. Upgrade for unlimited reports." },
        429,
      );
    }
  }

  // List all template files (excluding AUTHOR.md and folders)
  const allFiles = await lsRecursive(user.userId);
  const templateFiles = allFiles.filter(
    (f) => f !== "AUTHOR.md" && !f.endsWith("/AUTHOR.md") && !f.endsWith("/"),
  );

  if (templateFiles.length === 0) {
    return c.json({ error: "No templates found. Add templates first." }, 400);
  }

  // Per-request Bedrock wrapper. Every Bedrock call by the router/filler
  // below will be tracked: pre-checked against the org balance, then
  // deducted + counted after the call returns. Mock and Ollama paths
  // ignore the tracker entirely.
  const requestId = crypto.randomUUID();
  const tracker = new TrackedBedrock({
    userId: user.userId,
    orgId: user.orgId,
    requestId,
  });

  const aiRouter = await getAIRouter(tracker);
  const aiFiller = await getAIFiller(tracker);

  let route;
  try {
    route = await aiRouter.classifyIntent(
      templateFiles,
      body.message,
      body.sessionContext,
    );
  } catch (err) {
    if (err instanceof InsufficientBalanceError) {
      return c.json({ error: "Insufficient balance. Please top up." }, 402);
    }
    throw err;
  }

  if (route.intent === "NEW_FILL" || route.intent === "RE_SELECT") {
    if (!route.templateId) {
      return c.json({ error: "Could not match a template" }, 400);
    }

    // Verify the template exists in our file list
    if (!templateFiles.includes(route.templateId)) {
      return c.json({ error: "Matched template not found" }, 404);
    }

    // Load template content + nearest AUTHOR.md in parallel
    const [templateContent, authorContent] = await Promise.all([
      cat(user.userId, route.templateId),
      findAuthor(user.userId, route.templateId),
    ]);

    return stream(c, async (s) => {
      await s.write(
        `data: ${JSON.stringify({ type: "meta", intent: route.intent, templatePath: route.templateId })}\n\n`,
      );

      try {
        for await (const chunk of aiFiller.streamFillTemplate(
          authorContent || "",
          templateContent,
          body.message,
          body.conversationHistory,
        )) {
          if (chunk.type === "text") {
            await s.write(
              `data: ${JSON.stringify({ type: "text", text: chunk.text })}\n\n`,
            );
          } else if (chunk.type === "usage") {
            await s.write(
              `data: ${JSON.stringify({ type: "done", usage: chunk.data })}\n\n`,
            );
          }
        }
      } catch (err) {
        if (err instanceof InsufficientBalanceError) {
          await s.write(
            `data: ${JSON.stringify({ type: "error", error: "Insufficient balance" })}\n\n`,
          );
          return;
        }
        throw err;
      }
    });
  }

  if (route.intent === "REFINE") {
    if (!body.conversationHistory?.length) {
      return c.json({ error: "No active session to refine" }, 400);
    }

    const lastTemplatePath = body.sessionContext;
    if (!lastTemplatePath || !templateFiles.includes(lastTemplatePath)) {
      return c.json({ error: "Session template not found" }, 404);
    }

    // Load template content + nearest AUTHOR.md in parallel
    const [templateContent, authorContent] = await Promise.all([
      cat(user.userId, lastTemplatePath),
      findAuthor(user.userId, lastTemplatePath),
    ]);

    return stream(c, async (s) => {
      await s.write(
        `data: ${JSON.stringify({ type: "meta", intent: "REFINE", templatePath: lastTemplatePath })}\n\n`,
      );

      try {
        for await (const chunk of aiFiller.streamFillTemplate(
          authorContent || "",
          templateContent,
          body.message,
          body.conversationHistory,
        )) {
          if (chunk.type === "text") {
            await s.write(
              `data: ${JSON.stringify({ type: "text", text: chunk.text })}\n\n`,
            );
          } else if (chunk.type === "usage") {
            await s.write(
              `data: ${JSON.stringify({ type: "done", usage: chunk.data })}\n\n`,
            );
          }
        }
      } catch (err) {
        if (err instanceof InsufficientBalanceError) {
          await s.write(
            `data: ${JSON.stringify({ type: "error", error: "Insufficient balance" })}\n\n`,
          );
          return;
        }
        throw err;
      }
    });
  }

  return c.json({ error: `Intent ${route.intent} not yet implemented` }, 501);
});

export { fill };
