import { describe, it, expect } from "vitest";
import { calculateCost, modelTier } from "./tracker.js";

describe("modelTier", () => {
  it("maps haiku models to li", () => {
    expect(modelTier("anthropic.claude-haiku-4-5-20251001-v1:0")).toBe("li");
    expect(modelTier("anthropic.claude-haiku-4-5-20251001")).toBe("li");
  });

  it("maps sonnet models to md", () => {
    expect(modelTier("anthropic.claude-sonnet-4-6")).toBe("md");
    expect(modelTier("anthropic.claude-sonnet-4-20250514-v1:0")).toBe("md");
  });

  it("defaults unknown models to md", () => {
    expect(modelTier("unknown-model")).toBe("md");
  });
});

describe("calculateCost", () => {
  it("calculates haiku (li) cost correctly", () => {
    const cost = calculateCost("anthropic.claude-haiku-4-5-20251001", 1000, 500);
    // (1000 * 0.8 / 1_000_000) + (500 * 4.0 / 1_000_000) = 0.0008 + 0.002 = 0.0028
    expect(cost).toBeCloseTo(0.0028);
  });

  it("calculates sonnet (md) cost correctly", () => {
    const cost = calculateCost("anthropic.claude-sonnet-4-6", 1000, 500);
    // (1000 * 3.0 / 1_000_000) + (500 * 15.0 / 1_000_000) = 0.003 + 0.0075 = 0.0105
    expect(cost).toBeCloseTo(0.0105);
  });

  it("strips cross-region prefix and version suffix before lookup", () => {
    expect(calculateCost("us.anthropic.claude-haiku-4-5-20251001-v1:0", 1000, 500)).toBeCloseTo(0.0028);
    expect(calculateCost("eu.anthropic.claude-sonnet-4-20250514-v1:0", 1000, 500)).toBeCloseTo(0.0105);
  });

  it("returns 0 for unknown model", () => {
    expect(calculateCost("unknown-model", 1000, 500)).toBe(0);
  });

  it("handles zero tokens", () => {
    expect(calculateCost("anthropic.claude-haiku-4-5-20251001", 0, 0)).toBe(0);
  });
});
