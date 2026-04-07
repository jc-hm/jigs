import { describe, it, expect } from "vitest";
import { mockRouter, mockFiller } from "./mock.js";

const taxonomy = [
  { id: "mri-knee", name: "MRI Knee", description: "Standard knee MRI", s3Key: "templates/mri-knee.md" },
  { id: "ct-chest", name: "CT Chest", description: "Chest CT", s3Key: "templates/ct-chest.md" },
];

describe("mockRouter", () => {
  it("returns NEW_FILL for a normal message", async () => {
    const result = await mockRouter.classifyIntent(taxonomy, "left knee MRI normal");
    expect(result.intent).toBe("NEW_FILL");
    expect(result.templateId).toBe("mri-knee");
  });

  it("returns REFINE for modification requests", async () => {
    const result = await mockRouter.classifyIntent(taxonomy, "change the effusion to moderate");
    expect(result.intent).toBe("REFINE");
  });

  it("returns RE_SELECT for template switch requests", async () => {
    const result = await mockRouter.classifyIntent(taxonomy, "use a different template");
    expect(result.intent).toBe("RE_SELECT");
  });
});

describe("mockFiller", () => {
  it("yields text chunks followed by a usage event", async () => {
    const chunks = [];
    for await (const chunk of mockFiller.streamFillTemplate("", "", "", "test")) {
      chunks.push(chunk);
    }

    expect(chunks.length).toBeGreaterThan(1);

    const textChunks = chunks.filter((c) => c.type === "text");
    expect(textChunks.length).toBeGreaterThan(0);

    const usageChunks = chunks.filter((c) => c.type === "usage");
    expect(usageChunks).toHaveLength(1);

    const usage = usageChunks[0];
    if (usage.type === "usage") {
      expect(usage.data.inputTokens).toBeGreaterThan(0);
      expect(usage.data.outputTokens).toBeGreaterThan(0);
      expect(usage.data.modelId).toBe("mock-model");
    }
  });

  it("streams content that resembles a report", async () => {
    let fullText = "";
    for await (const chunk of mockFiller.streamFillTemplate("", "", "", "test")) {
      if (chunk.type === "text") fullText += chunk.text;
    }
    expect(fullText).toContain("Findings");
    expect(fullText).toContain("Impression");
  });
});
