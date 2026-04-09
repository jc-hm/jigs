import { Hono } from "hono";
import { stream } from "hono/streaming";
import { getAIRouter, getAIFiller } from "../services/ai/provider.js";
import { lsRecursive, cat, findAuthor } from "../services/files/operations.js";
import { checkFreeLimit, recordUsage } from "../services/billing/tracker.js";
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

  // Check free tier (skipped in local dev)
  if (!config.isLocal) {
    const allowed = await checkFreeLimit(user.userId);
    if (!allowed) {
      return c.json(
        { error: "Daily free limit reached. Upgrade for unlimited reports." },
        429
      );
    }
  }

  // List all template files (excluding AUTHOR.md and folders)
  const allFiles = await lsRecursive(user.userId);
  const templateFiles = allFiles.filter(
    (f) => f !== "AUTHOR.md" && !f.endsWith("/AUTHOR.md") && !f.endsWith("/")
  );

  if (templateFiles.length === 0) {
    return c.json({ error: "No templates found. Add templates first." }, 400);
  }

  // Resolve AI services
  const aiRouter = await getAIRouter();
  const aiFiller = await getAIFiller();

  // Route intent
  const route = await aiRouter.classifyIntent(
    templateFiles,
    body.message,
    body.sessionContext
  );

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
        `data: ${JSON.stringify({ type: "meta", intent: route.intent, templatePath: route.templateId })}\n\n`
      );

      for await (const chunk of aiFiller.streamFillTemplate(
        authorContent || "",
        templateContent,
        body.message,
        body.conversationHistory
      )) {
        if (chunk.type === "text") {
          await s.write(
            `data: ${JSON.stringify({ type: "text", text: chunk.text })}\n\n`
          );
        } else if (chunk.type === "usage") {
          await recordUsage(
            user.userId,
            user.orgId,
            chunk.data.modelId,
            chunk.data.inputTokens,
            chunk.data.outputTokens
          );
          await s.write(
            `data: ${JSON.stringify({ type: "done", usage: chunk.data })}\n\n`
          );
        }
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
        `data: ${JSON.stringify({ type: "meta", intent: "REFINE", templatePath: lastTemplatePath })}\n\n`
      );

      for await (const chunk of aiFiller.streamFillTemplate(
        authorContent || "",
        templateContent,
        body.message,
        body.conversationHistory
      )) {
        if (chunk.type === "text") {
          await s.write(
            `data: ${JSON.stringify({ type: "text", text: chunk.text })}\n\n`
          );
        } else if (chunk.type === "usage") {
          await recordUsage(
            user.userId,
            user.orgId,
            chunk.data.modelId,
            chunk.data.inputTokens,
            chunk.data.outputTokens
          );
          await s.write(
            `data: ${JSON.stringify({ type: "done", usage: chunk.data })}\n\n`
          );
        }
      }
    });
  }

  return c.json({ error: `Intent ${route.intent} not yet implemented` }, 501);
});

export { fill };
