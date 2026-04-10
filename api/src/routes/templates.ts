import { Hono } from "hono";
import { stream } from "hono/streaming";
import {
  ls,
  lsRecursive,
  cat,
  write,
  rm,
  mv,
  mkdir,
} from "../services/files/operations.js";
import { getAIAgent } from "../services/ai/provider.js";
import { TrackedBedrock } from "../services/billing/tracked-bedrock.js";
import { InsufficientBalanceError } from "../services/billing/tracker.js";
import { sseLine } from "../lib/sse.js";
import { log } from "../lib/log.js";
import type { AppEnv } from "../types.js";

const templates = new Hono<AppEnv>();

// List directory contents
templates.get("/ls", async (c) => {
  const user = c.get("user");
  const path = c.req.query("path") || "";
  const entries = await ls(user.userId, path);
  return c.json(entries);
});

// Read file content
templates.get("/cat", async (c) => {
  const user = c.get("user");
  const path = c.req.query("path");
  if (!path) return c.json({ error: "path is required" }, 400);

  try {
    const content = await cat(user.userId, path);
    return c.json({ path, content });
  } catch {
    return c.json({ error: "File not found" }, 404);
  }
});

// Create or update a file
templates.put("/write", async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{ path: string; content: string }>();
  if (!body.path?.trim()) return c.json({ error: "path is required" }, 400);
  if (body.content === undefined) return c.json({ error: "content is required" }, 400);

  await write(user.userId, body.path, body.content);
  return c.json({ message: "ok", path: body.path });
});

// Delete a file
templates.post("/rm", async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{ path: string }>();
  if (!body.path?.trim()) return c.json({ error: "path is required" }, 400);

  await rm(user.userId, body.path);
  return c.json({ message: "ok", path: body.path });
});

// Move/rename a file
templates.post("/mv", async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{ from: string; to: string }>();
  if (!body.from?.trim() || !body.to?.trim()) {
    return c.json({ error: "from and to are required" }, 400);
  }

  await mv(user.userId, body.from, body.to);
  return c.json({ message: "ok", from: body.from, to: body.to });
});

// Create a folder
templates.post("/mkdir", async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{ path: string }>();
  if (!body.path?.trim()) return c.json({ error: "path is required" }, 400);

  await mkdir(user.userId, body.path);
  return c.json({ message: "ok", path: body.path });
});

// AI agent: natural language file operations.
//
// Streams progress as Server-Sent Events. Each tool call the agent
// performs becomes a `tool` event the moment it lands; the loop ends
// with a `complete` event carrying the final summary and changedPaths.
// We stream rather than block on a single JSON response because the
// loop can take 60-120s under Bedrock throttling, and CloudFront's
// origin response timeout (~30s for non-streaming) was killing the
// connection mid-loop even when Lambda ran to completion.
templates.post("/agent", async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{
    message: string;
    conversationHistory?: Array<{ role: "user" | "assistant"; text: string }>;
  }>();
  if (!body.message?.trim()) return c.json({ error: "message is required" }, 400);

  const allFiles = await lsRecursive(user.userId);
  const requestId = c.get("requestId");

  return stream(c, async (s) => {
    // Per-request Bedrock wrapper. The agent loop can run up to 10 Sonnet
    // rounds; each round is tracked individually with its agentRound number.
    // requestId comes from the global middleware so all logs for this
    // request (router, agent rounds, errors) share the same id.
    //
    // onRetry is wired here (inside the stream callback) so the writer
    // `s` is in scope: every retry attempt the wrapper makes is forwarded
    // to the frontend in real time as a `retry` SSE event, no queueing
    // needed because the agent loop awaits converse() which awaits this
    // callback — JS single-threaded means writes can't interleave.
    const tracker = new TrackedBedrock(
      { userId: user.userId, orgId: user.orgId, requestId },
      {
        onRetry: async (info) => {
          await s.write(
            sseLine({
              type: "retry",
              attempt: info.attempt,
              maxAttempts: info.maxAttempts,
              errorName: info.errorName,
              delayMs: info.delayMs,
              action: info.action,
            }),
          );
        },
      },
    );

    const agent = await getAIAgent(tracker);

    try {
      for await (const event of agent.executeFileOperations(
        user.userId,
        body.message,
        allFiles,
        body.conversationHistory,
      )) {
        await s.write(sseLine(event));
      }
    } catch (err) {
      // Mid-stream failure: we already returned 200 with SSE headers,
      // so we can't change the HTTP status. Best we can do is emit a
      // final `error` event the frontend renders as a chat error, then
      // log it loudly so investigation is the same as any other 500.
      if (err instanceof InsufficientBalanceError) {
        await s.write(
          sseLine({ type: "error", message: "Insufficient balance. Please top up." }),
        );
        return;
      }
      log.error("agent.stream.failed", err, {
        requestId,
        userId: user.userId,
        orgId: user.orgId,
      });
      const message =
        err instanceof Error ? err.message : "Internal server error";
      await s.write(sseLine({ type: "error", message }));
    }
  });
});

export { templates };
