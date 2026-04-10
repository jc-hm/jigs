import { describe, it, expect } from "vitest";
import { calculateCost } from "./tracker.js";

describe("calculateCost", () => {
  it("calculates Haiku cost correctly", () => {
    const cost = calculateCost("anthropic.claude-haiku-4-5-20251001", 1000, 500);
    // (1000 * 0.8 / 1_000_000) + (500 * 4.0 / 1_000_000) = 0.0008 + 0.002 = 0.0028
    expect(cost).toBeCloseTo(0.0028);
  });

  it("calculates Sonnet cost correctly", () => {
    const cost = calculateCost("anthropic.claude-sonnet-4-20250514", 1000, 500);
    // (1000 * 3.0 / 1_000_000) + (500 * 15.0 / 1_000_000) = 0.003 + 0.0075 = 0.0105
    expect(cost).toBeCloseTo(0.0105);
  });

  it("normalizes Bedrock cross-region inference IDs (us. prefix, version suffix)", () => {
    // Real IDs returned by the Bedrock SDK include a region prefix and a
    // version suffix; calculateCost must strip both before lookup.
    const cost = calculateCost(
      "us.anthropic.claude-haiku-4-5-20251001-v1:0",
      1000,
      500,
    );
    expect(cost).toBeCloseTo(0.0028);
  });

  it("normalizes Sonnet inference profile ID", () => {
    const cost = calculateCost(
      "us.anthropic.claude-sonnet-4-20250514-v1:0",
      1000,
      500,
    );
    expect(cost).toBeCloseTo(0.0105);
  });

  it("returns 0 for unknown model", () => {
    expect(calculateCost("unknown-model", 1000, 500)).toBe(0);
  });

  it("handles zero tokens", () => {
    expect(calculateCost("anthropic.claude-haiku-4-5-20251001", 0, 0)).toBe(0);
  });
});
