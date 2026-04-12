import { describe, it, expect, beforeAll } from "vitest";
import { app } from "../app.js";
import { seedTestData } from "../../test/helpers/setup.js";

describe("Billing endpoints", () => {
  beforeAll(async () => {
    process.env.STAGE = "local";
    await seedTestData();
  });

  it("GET /api/v1/billing/usage returns balance with lifetime counter", async () => {
    const res = await app.request("/api/v1/billing/usage");
    expect(res.status).toBe(200);

    const usage = await res.json();
    expect(usage).toHaveProperty("balance");
    expect(usage).not.toHaveProperty("daily");
    expect(usage).not.toHaveProperty("monthly");

    // Balance shape — seed grants $10 to test-org.
    expect(usage.balance).toHaveProperty("balanceUsd");
    expect(usage.balance).toHaveProperty("topUpsUsd");
    expect(usage.balance).toHaveProperty("spentUsd");
    expect(usage.balance).toHaveProperty("reportsLifetime");
    expect(usage.balance.balanceUsd).toBeGreaterThan(0);
    expect(typeof usage.balance.reportsLifetime).toBe("number");
  });
});
