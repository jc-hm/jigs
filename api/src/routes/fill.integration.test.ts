import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { app } from "../app.js";
import { seedTestData, injectMockAI, resetMockAI } from "../../test/helpers/setup.js";

describe("POST /api/v1/fill", () => {
  beforeAll(async () => {
    process.env.STAGE = "local";
    injectMockAI();
    await seedTestData();
  });

  afterAll(() => {
    resetMockAI();
  });

  it("streams a filled report as SSE events", async () => {
    const res = await app.request("/api/v1/fill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Normal knee MRI, no findings",
      }),
    });

    expect(res.status).toBe(200);

    const text = await res.text();
    const events = text
      .split("\n\n")
      .filter(Boolean)
      .map((e) => JSON.parse(e.replace("data: ", "")));

    // First event: meta
    expect(events[0].type).toBe("meta");
    expect(events[0].intent).toBe("NEW_FILL");
    expect(events[0].templatePath).toBeDefined();

    // Last event: done with usage
    const last = events[events.length - 1];
    expect(last.type).toBe("done");
    expect(last.usage.inputTokens).toBeGreaterThan(0);

    // Middle events: text chunks
    const textEvents = events.filter((e) => e.type === "text");
    expect(textEvents.length).toBeGreaterThan(0);
  });

  it("allows multiple fills in local mode (no free tier limit)", async () => {
    const res = await app.request("/api/v1/fill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Another knee MRI",
      }),
    });

    expect(res.status).toBe(200);
  });

  it("handles REFINE with conversation history", async () => {
    const res = await app.request("/api/v1/fill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "change the effusion to moderate",
        sessionContext: "mri-knee.md",
        conversationHistory: [
          { role: "user", text: "Normal knee MRI" },
          { role: "assistant", text: "Report generated." },
        ],
      }),
    });

    expect(res.status).toBe(200);

    const text = await res.text();
    const events = text
      .split("\n\n")
      .filter(Boolean)
      .map((e) => JSON.parse(e.replace("data: ", "")));

    expect(events[0].type).toBe("meta");
    expect(events[0].intent).toBe("REFINE");
  });

  it("returns 400 for REFINE without conversation history", async () => {
    const res = await app.request("/api/v1/fill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "change the effusion to moderate",
        sessionContext: "mri-knee.md",
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("No active session");
  });
});
