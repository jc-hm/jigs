import { describe, it, expect, beforeAll } from "vitest";
import { app } from "../app.js";
import { seedTestData } from "../../test/helpers/setup.js";

describe("Skills CRUD", () => {
  beforeAll(async () => {
    process.env.STAGE = "local";
    await seedTestData();
  });

  it("GET /api/v1/skills lists skills", async () => {
    const res = await app.request("/api/v1/skills");
    expect(res.status).toBe(200);

    const skills = await res.json();
    expect(Array.isArray(skills)).toBe(true);
    expect(skills.length).toBeGreaterThan(0);
    expect(skills[0].id).toBe("radiology");
    expect(skills[0].taxonomy).toHaveLength(3);
  });

  it("GET /api/v1/skills/:id returns a single skill", async () => {
    const res = await app.request("/api/v1/skills/radiology");
    expect(res.status).toBe(200);

    const skill = await res.json();
    expect(skill.id).toBe("radiology");
    expect(skill.name).toBe("Radiology Report Generator");
  });

  it("GET /api/v1/skills/:id returns 404 for unknown skill", async () => {
    const res = await app.request("/api/v1/skills/nonexistent");
    expect(res.status).toBe(404);
  });
});
