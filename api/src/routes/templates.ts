import { Hono } from "hono";
import { getSkill, putSkill } from "../db/entities.js";
import {
  getTemplateContent,
  putTemplateContent,
  forkTemplate,
} from "../services/templates/lookup.js";
import { randomUUID } from "crypto";
import type { AppEnv } from "../types.js";

const templates = new Hono<AppEnv>();

// Get template content
templates.get("/:skillId/:templateId", async (c) => {
  const user = c.get("user");
  const skill = await getSkill(user.orgId, c.req.param("skillId"));
  if (!skill) return c.json({ error: "Skill not found" }, 404);

  const entry = skill.taxonomy.find(
    (t) => t.id === c.req.param("templateId")
  );
  if (!entry) return c.json({ error: "Template not found" }, 404);

  const content = await getTemplateContent(
    user.orgId,
    user.userId,
    entry.s3Key
  );
  return c.json({ ...entry, content });
});

// Upload a template (admin only)
templates.post("/:skillId", async (c) => {
  const user = c.get("user");
  if (user.role !== "admin") {
    return c.json({ error: "Admin only" }, 403);
  }

  const skill = await getSkill(user.orgId, c.req.param("skillId"));
  if (!skill) return c.json({ error: "Skill not found" }, 404);

  const body = await c.req.json<{
    name: string;
    description: string;
    modality?: string;
    bodyPart?: string;
    content: string;
  }>();

  const templateId = randomUUID().slice(0, 8);
  const s3Key = `templates/${templateId}.md`;

  // Upload content to S3
  await putTemplateContent(user.orgId, s3Key, body.content);

  // Add to skill taxonomy
  skill.taxonomy.push({
    id: templateId,
    name: body.name,
    modality: body.modality,
    bodyPart: body.bodyPart,
    description: body.description,
    s3Key,
  });
  await putSkill(skill);

  return c.json({ id: templateId, s3Key }, 201);
});

// Fork a template (user creates their own version)
templates.post("/:skillId/:templateId/fork", async (c) => {
  const user = c.get("user");
  const skill = await getSkill(user.orgId, c.req.param("skillId"));
  if (!skill) return c.json({ error: "Skill not found" }, 404);

  const entry = skill.taxonomy.find(
    (t) => t.id === c.req.param("templateId")
  );
  if (!entry) return c.json({ error: "Template not found" }, 404);

  // Get original content, then save as user fork
  const content = await getTemplateContent(
    user.orgId,
    user.userId,
    entry.s3Key
  );

  const body = await c.req.json<{ content?: string }>().catch((): { content?: string } => ({}));
  await forkTemplate(
    user.orgId,
    user.userId,
    entry.s3Key,
    body.content || content
  );

  return c.json({ message: "Template forked", s3Key: entry.s3Key });
});

export { templates };
