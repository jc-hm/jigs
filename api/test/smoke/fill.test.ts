import { describe, it, expect } from "vitest";

const TARGET_URL = process.env.TARGET_URL;
const AUTH_TOKEN = process.env.AUTH_TOKEN;

if (!TARGET_URL) throw new Error("TARGET_URL env var required for smoke tests");
if (!AUTH_TOKEN) throw new Error("AUTH_TOKEN env var required for smoke tests");

describe("Fill endpoint (smoke)", () => {
  it("streams a filled report end-to-end", async () => {
    const res = await fetch(`${TARGET_URL}/api/v1/fill`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${AUTH_TOKEN}`,
      },
      body: JSON.stringify({
        skillId: "radiology",
        message: "Normal knee MRI, no acute findings",
      }),
    });

    expect(res.status).toBe(200);

    const text = await res.text();
    const events = text
      .split("\n\n")
      .filter(Boolean)
      .map((e) => JSON.parse(e.replace("data: ", "")));

    // Must have meta, at least one text, and done
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("meta");
    expect(types).toContain("text");
    expect(types[types.length - 1]).toBe("done");

    // Done event must have usage with real token counts
    const done = events[events.length - 1];
    expect(done.usage.inputTokens).toBeGreaterThan(0);
    expect(done.usage.outputTokens).toBeGreaterThan(0);
  });
});
