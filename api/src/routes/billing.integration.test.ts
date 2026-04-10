import { describe, it, expect, beforeAll } from "vitest";
import { app } from "../app.js";
import { seedTestData } from "../../test/helpers/setup.js";

describe("Billing endpoints", () => {
  beforeAll(async () => {
    process.env.STAGE = "local";
    await seedTestData();
  });

  it("GET /api/v1/billing/usage returns usage, counters, and balance", async () => {
    const res = await app.request("/api/v1/billing/usage");
    expect(res.status).toBe(200);

    const usage = await res.json();
    expect(usage).toHaveProperty("daily");
    expect(usage).toHaveProperty("monthly");
    expect(usage).toHaveProperty("balance");

    expect(usage.daily).toHaveProperty("reportCount");
    expect(typeof usage.daily.reportCount).toBe("number");

    // Monthly counters now include token + per-call-type breakdowns.
    expect(usage.monthly).toHaveProperty("reportCount");
    expect(usage.monthly).toHaveProperty("totalCostUsd");
    expect(usage.monthly).toHaveProperty("inputTokens");
    expect(usage.monthly).toHaveProperty("outputTokens");
    expect(usage.monthly).toHaveProperty("routerCalls");
    expect(usage.monthly).toHaveProperty("fillerCalls");
    expect(usage.monthly).toHaveProperty("agentRounds");

    // Balance shape — seed grants $10 to test-org.
    expect(usage.balance).toHaveProperty("balanceUsd");
    expect(usage.balance).toHaveProperty("topUpsUsd");
    expect(usage.balance).toHaveProperty("spentUsd");
    expect(usage.balance.balanceUsd).toBeGreaterThan(0);
  });
});
