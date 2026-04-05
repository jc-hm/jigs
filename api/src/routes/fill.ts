import { Hono } from "hono";
import { stream } from "hono/streaming";
import { getSkill } from "../db/entities.js";
import { classifyIntent } from "../services/ai/router.js";
import { streamFillTemplate } from "../services/ai/filler.js";
import { getTemplateContent } from "../services/templates/lookup.js";
import { checkFreeLimit, recordUsage } from "../services/billing/tracker.js";
import type { AppEnv } from "../types.js";

const fill = new Hono<AppEnv>();

fill.post("/", async (c) => {
  const user = c.get("user");

  // Parse request
  const body = await c.req.json<{
    skillId: string;
    message: string;
    sessionContext?: string;
    conversationHistory?: Array<{ role: "user" | "assistant"; text: string }>;
  }>();

  // Check free tier
  const allowed = await checkFreeLimit(user.userId);
  if (!allowed) {
    return c.json(
      { error: "Daily free limit reached. Upgrade for unlimited reports." },
      429
    );
  }

  // Load skill
  const skill = await getSkill(user.orgId, body.skillId);
  if (!skill) {
    return c.json({ error: "Skill not found" }, 404);
  }

  // Route intent via Haiku
  const route = await classifyIntent(
    skill.taxonomy,
    body.message,
    body.sessionContext
  );

  if (route.intent === "NEW_FILL" || route.intent === "RE_SELECT") {
    if (!route.templateId) {
      return c.json({ error: "Could not match a template" }, 400);
    }

    // Find template in taxonomy
    const templateEntry = skill.taxonomy.find(
      (t) => t.id === route.templateId
    );
    if (!templateEntry) {
      return c.json({ error: "Template not found in taxonomy" }, 404);
    }

    // Load template content from S3
    const templateContent = await getTemplateContent(
      user.orgId,
      user.userId,
      templateEntry.s3Key
    );

    // Stream the filled report
    return stream(c, async (s) => {
      // Send intent metadata as first event
      await s.write(
        `data: ${JSON.stringify({ type: "meta", intent: route.intent, templateId: route.templateId, templateName: templateEntry.name })}\n\n`
      );

      for await (const chunk of streamFillTemplate(
        skill.instructions,
        skill.tone,
        templateContent,
        body.message,
        body.conversationHistory
      )) {
        if (chunk.type === "text") {
          await s.write(
            `data: ${JSON.stringify({ type: "text", text: chunk.text })}\n\n`
          );
        } else if (chunk.type === "usage") {
          // Record usage
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
    // For REFINE, we need the current template and conversation history
    if (!body.conversationHistory?.length) {
      return c.json({ error: "No active session to refine" }, 400);
    }

    // Use the template from the last fill (client sends it)
    const lastTemplateId = body.sessionContext;
    const templateEntry = skill.taxonomy.find(
      (t) => t.id === lastTemplateId
    );
    if (!templateEntry) {
      return c.json({ error: "Session template not found" }, 404);
    }

    const templateContent = await getTemplateContent(
      user.orgId,
      user.userId,
      templateEntry.s3Key
    );

    return stream(c, async (s) => {
      await s.write(
        `data: ${JSON.stringify({ type: "meta", intent: "REFINE", templateId: lastTemplateId })}\n\n`
      );

      for await (const chunk of streamFillTemplate(
        skill.instructions,
        skill.tone,
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
