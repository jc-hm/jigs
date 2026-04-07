import { describe, it, expect } from "vitest";

const TARGET_URL = process.env.TARGET_URL;
const AUTH_TOKEN = process.env.AUTH_TOKEN;

if (!TARGET_URL) throw new Error("TARGET_URL env var required for smoke tests");
if (!AUTH_TOKEN) throw new Error("AUTH_TOKEN env var required for smoke tests");

describe("Skills endpoint (smoke)", () => {
  it("lists skills", async () => {
    const res = await fetch(`${TARGET_URL}/api/v1/skills`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    });

    expect(res.status).toBe(200);
    const skills = await res.json();
    expect(Array.isArray(skills)).toBe(true);
    expect(skills.length).toBeGreaterThan(0);
    expect(skills[0]).toHaveProperty("id");
    expect(skills[0]).toHaveProperty("taxonomy");
  });
});
