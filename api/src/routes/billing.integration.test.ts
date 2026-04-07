import { describe, it, expect, beforeAll } from "vitest";
import { app } from "../app.js";
import { seedTestData } from "../../test/helpers/setup.js";

describe("Billing endpoints", () => {
  beforeAll(async () => {
    process.env.STAGE = "local";
    await seedTestData();
  });

  it("GET /api/v1/billing/usage returns usage data", async () => {
    const res = await app.request("/api/v1/billing/usage");
    expect(res.status).toBe(200);

    const usage = await res.json();
    expect(usage).toHaveProperty("daily");
    expect(usage).toHaveProperty("monthly");
    expect(usage.daily).toHaveProperty("reportCount");
    expect(typeof usage.daily.reportCount).toBe("number");
    expect(usage.monthly).toHaveProperty("reportCount");
    expect(usage.monthly).toHaveProperty("totalCostUsd");
  });
});
