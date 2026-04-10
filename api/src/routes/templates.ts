import { Hono } from "hono";
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

// AI agent: natural language file operations
templates.post("/agent", async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{ message: string }>();
  if (!body.message?.trim()) return c.json({ error: "message is required" }, 400);

  const allFiles = await lsRecursive(user.userId);

  // Per-request Bedrock wrapper. The agent loop can run up to 10 Sonnet
  // rounds; each round is tracked individually with its agentRound number.
  const requestId = crypto.randomUUID();
  const tracker = new TrackedBedrock({
    userId: user.userId,
    orgId: user.orgId,
    requestId,
  });

  try {
    const agent = await getAIAgent(tracker);
    const result = await agent.executeFileOperations(user.userId, body.message, allFiles);
    return c.json(result);
  } catch (err) {
    if (err instanceof InsufficientBalanceError) {
      return c.json({ error: "Insufficient balance. Please top up." }, 402);
    }
    throw err;
  }
});

export { templates };
