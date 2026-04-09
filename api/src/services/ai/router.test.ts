import { describe, it, expect } from "vitest";
import { buildRouterPrompt } from "./router.js";

const filenames = ["mri-knee.md", "ct-chest.md", "neuro/brain-mri.md"];

describe("buildRouterPrompt", () => {
  it("includes all filenames", () => {
    const prompt = buildRouterPrompt(filenames);
    expect(prompt).toContain("- mri-knee.md");
    expect(prompt).toContain("- ct-chest.md");
    expect(prompt).toContain("- neuro/brain-mri.md");
  });

  it("includes intent definitions", () => {
    const prompt = buildRouterPrompt(filenames);
    expect(prompt).toContain("NEW_FILL");
    expect(prompt).toContain("REFINE");
    expect(prompt).toContain("RE_SELECT");
    expect(prompt).toContain("UPDATE_TMPL");
  });

  it("includes session context when provided", () => {
    const prompt = buildRouterPrompt(filenames, "mri-knee.md");
    expect(prompt).toContain("Current session context: mri-knee.md");
  });

  it("shows no active session when context is absent", () => {
    const prompt = buildRouterPrompt(filenames);
    expect(prompt).toContain("No active session.");
  });
});
