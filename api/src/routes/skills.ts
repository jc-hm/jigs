import { Hono } from "hono";
import { getSkill, putSkill, listSkills } from "../db/entities.js";
import { randomUUID } from "crypto";
import type { AppEnv } from "../types.js";

const skills = new Hono<AppEnv>();

// List skills for the org
skills.get("/", async (c) => {
  const user = c.get("user");
  const result = await listSkills(user.orgId);
  return c.json(result);
});

// Get a specific skill
skills.get("/:skillId", async (c) => {
  const user = c.get("user");
  const skill = await getSkill(user.orgId, c.req.param("skillId"));
  if (!skill) return c.json({ error: "Not found" }, 404);
  return c.json(skill);
});

// Create a skill (admin only)
skills.post("/", async (c) => {
  const user = c.get("user");
  if (user.role !== "admin") {
    return c.json({ error: "Admin only" }, 403);
  }

  const body = await c.req.json<{
    name: string;
    tone: string;
    instructions: string;
  }>();

  const skill = {
    id: randomUUID().slice(0, 8),
    orgId: user.orgId,
    name: body.name,
    tone: body.tone,
    instructions: body.instructions,
    taxonomy: [],
  };

  await putSkill(skill);
  return c.json(skill, 201);
});

// Update a skill (admin only)
skills.put("/:skillId", async (c) => {
  const user = c.get("user");
  if (user.role !== "admin") {
    return c.json({ error: "Admin only" }, 403);
  }

  const existing = await getSkill(user.orgId, c.req.param("skillId"));
  if (!existing) return c.json({ error: "Not found" }, 404);

  const body = await c.req.json<Partial<{
    name: string;
    tone: string;
    instructions: string;
    taxonomy: typeof existing.taxonomy;
  }>>();

  const updated = {
    ...existing,
    name: body.name ?? existing.name,
    tone: body.tone ?? existing.tone,
    instructions: body.instructions ?? existing.instructions,
    taxonomy: body.taxonomy ?? existing.taxonomy,
  };

  await putSkill(updated);
  return c.json(updated);
});

export { skills };
