import { describe, it, expect } from "vitest";
import { buildRouterPrompt } from "./router.js";
import type { TemplateTaxonomyEntry } from "../../db/entities.js";

const taxonomy: TemplateTaxonomyEntry[] = [
  { id: "mri-knee", name: "MRI Knee", description: "Standard knee MRI", s3Key: "templates/mri-knee.md" },
  { id: "ct-chest", name: "CT Chest", description: "Chest CT", s3Key: "templates/ct-chest.md" },
];

describe("buildRouterPrompt", () => {
  it("includes all template IDs and names", () => {
    const prompt = buildRouterPrompt(taxonomy);
    expect(prompt).toContain("mri-knee: MRI Knee");
    expect(prompt).toContain("ct-chest: CT Chest");
  });

  it("includes intent definitions", () => {
    const prompt = buildRouterPrompt(taxonomy);
    expect(prompt).toContain("NEW_FILL");
    expect(prompt).toContain("REFINE");
    expect(prompt).toContain("RE_SELECT");
    expect(prompt).toContain("UPDATE_TMPL");
  });

  it("includes session context when provided", () => {
    const prompt = buildRouterPrompt(taxonomy, "mri-knee");
    expect(prompt).toContain("Current session context: mri-knee");
  });

  it("shows no active session when context is absent", () => {
    const prompt = buildRouterPrompt(taxonomy);
    expect(prompt).toContain("No active session.");
  });
});
