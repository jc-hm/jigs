import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { getAIRouter, getAIFiller } from "../services/ai/provider.js";
import { lsRecursive, cat, findAuthor } from "../services/files/operations.js";
import { InsufficientBalanceError, incrementReportCount } from "../services/billing/tracker.js";
import { TrackedBedrock } from "../services/billing/tracked-bedrock.js";
import { writeEvent, writeComment, startHeartbeat } from "../lib/sse.js";
import type { AppEnv } from "../types.js";

const fill = new Hono<AppEnv>();

fill.post("/", async (c) => {
  const user = c.get("user");

  const body = await c.req.json<{
    message: string;
    sessionContext?: string;
    conversationHistory?: Array<{ role: "user" | "assistant"; text: string }>;
  }>();

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
  // ignore the tracker entirely. requestId comes from the global middleware
  // so all log lines for this request share the same id.
  const requestId = c.get("requestId");
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

    return streamSSE(c, async (s) => {
      // Initial comment + heartbeat so CloudFront's 30s origin-response
      // timeout doesn't fire while Sonnet warms up on big templates. See
      // sse.ts#startHeartbeat. The meta event below also counts as first
      // byte, but the explicit comment is cheap insurance.
      await writeComment(s, "start");
      const stopHeartbeat = startHeartbeat(s);
      try {
        await writeEvent(s, {
          type: "meta",
          intent: route.intent,
          templatePath: route.templateId,
        });

        for await (const chunk of aiFiller.streamFillTemplate(
          authorContent || "",
          templateContent,
          body.message,
          body.conversationHistory,
        )) {
          if (chunk.type === "text") {
            await writeEvent(s, { type: "text", text: chunk.text });
          } else if (chunk.type === "usage") {
            await writeEvent(s, { type: "done", usage: chunk.data });
            // Count as a report only when the model actually filled a template
            // from scratch (NEW_FILL). RE_SELECT and REFINE don't count —
            // RE_SELECT corrects a routing mistake, REFINE modifies an existing
            // report. The router's intent classification (Haiku) is the source
            // of truth here, not a heuristic on the Bedrock call itself.
            if (route.intent === "NEW_FILL") {
              await incrementReportCount(user.orgId).catch(() => {});
            }
          }
        }
      } catch (err) {
        if (err instanceof InsufficientBalanceError) {
          await writeEvent(s, { type: "error", error: "Insufficient balance" });
          return;
        }
        throw err;
      } finally {
        stopHeartbeat();
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

    return streamSSE(c, async (s) => {
      // Same initial-comment + heartbeat as the NEW_FILL/RE_SELECT branch.
      await writeComment(s, "start");
      const stopHeartbeat = startHeartbeat(s);
      try {
        await writeEvent(s, {
          type: "meta",
          intent: "REFINE",
          templatePath: lastTemplatePath,
        });

        for await (const chunk of aiFiller.streamFillTemplate(
          authorContent || "",
          templateContent,
          body.message,
          body.conversationHistory,
        )) {
          if (chunk.type === "text") {
            await writeEvent(s, { type: "text", text: chunk.text });
          } else if (chunk.type === "usage") {
            await writeEvent(s, { type: "done", usage: chunk.data });
          }
        }
      } catch (err) {
        if (err instanceof InsufficientBalanceError) {
          await writeEvent(s, { type: "error", error: "Insufficient balance" });
          return;
        }
        throw err;
      } finally {
        stopHeartbeat();
      }
    });
  }

  return c.json({ error: `Intent ${route.intent} not yet implemented` }, 501);
});

export { fill };
