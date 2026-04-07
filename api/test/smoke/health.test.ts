import { describe, it, expect } from "vitest";

const TARGET_URL = process.env.TARGET_URL;
if (!TARGET_URL) throw new Error("TARGET_URL env var required for smoke tests");

describe("Health check", () => {
  it("returns 200 with status ok", async () => {
    const res = await fetch(`${TARGET_URL}/api/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });
});
