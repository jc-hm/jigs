import {
  deductBalance,
  getDailyUsage,
  getOrgBalance,
  incrementUsageCounters,
  type UsageAction,
} from "../../db/entities.js";

// Bedrock list-price per million tokens (USD). These are our underlying costs.
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "anthropic.claude-haiku-4-5-20251001": { input: 0.8, output: 4.0 },
  "anthropic.claude-sonnet-4-20250514": { input: 3.0, output: 15.0 },
};

/**
 * Markup applied on top of the underlying Bedrock cost when deducting from
 * the org balance. 1.0 = pass-through (no margin). Set this when pricing is
 * decided. Customer-facing price = bedrockCost * SPREAD.
 */
export const SPREAD = 1.0;

export function calculateCost(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
): number {
  // Model IDs from Bedrock include a region inference prefix
  // (e.g. "us.anthropic.claude-haiku-4-5-20251001-v1:0"). Strip the prefix
  // and version suffix so the lookup matches the pricing table.
  const normalized = modelId
    .replace(/^[a-z]{2}\./, "") // strip "us.", "eu." etc.
    .replace(/-v\d+:\d+$/, ""); // strip "-v1:0"
  const pricing = MODEL_PRICING[normalized];
  if (!pricing) return 0;
  return (
    (inputTokens * pricing.input) / 1_000_000 +
    (outputTokens * pricing.output) / 1_000_000
  );
}

/**
 * Free-tier daily report cap, used while we transition to a pure
 * balance-based model. Once topups are wired up and new users get a
 * starter credit, this can be retired in favour of `assertBalance` only.
 */
const FREE_DAILY_LIMIT = 10;

export async function checkFreeLimit(userId: string): Promise<boolean> {
  const dailyCount = await getDailyUsage(userId);
  return dailyCount < FREE_DAILY_LIMIT;
}

export class InsufficientBalanceError extends Error {
  constructor(public orgId: string, public balanceUsd: number) {
    super(`Insufficient balance for org ${orgId}: ${balanceUsd.toFixed(4)} USD`);
    this.name = "InsufficientBalanceError";
  }
}

/**
 * Pre-call gate. Throws InsufficientBalanceError if the org's balance is
 * not strictly positive. Called before every Bedrock invocation.
 */
export async function assertBalance(orgId: string): Promise<void> {
  const { balanceUsd } = await getOrgBalance(orgId);
  if (balanceUsd <= 0) {
    throw new InsufficientBalanceError(orgId, balanceUsd);
  }
}

export interface TrackedCall {
  userId: string;
  orgId: string;
  requestId: string;
  action: UsageAction;
  templatePath?: string;
  agentRound?: number;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}

/**
 * Records a successful Bedrock call: deducts the marked-up cost from the
 * org balance and increments per-user/per-org monthly counters. Called from
 * the TrackedBedrock wrapper after each successful call.
 *
 * Failures are not retried — usage tracking should never block the API
 * response, so callers may want to swallow errors. The wrapper logs them.
 */
export async function trackAndDeduct(call: TrackedCall): Promise<void> {
  const bedrockCost = calculateCost(
    call.modelId,
    call.inputTokens,
    call.outputTokens,
  );
  const chargedCost = bedrockCost * SPREAD;

  // fill/refine calls produce a user-visible report; router and agent_round
  // calls do not. Only the former bump the BALANCE row's `reportsLifetime`
  // counter (surfaced on the Profile page as "Total Reports").
  const isReport = call.action === "fill" || call.action === "refine";

  await Promise.all([
    deductBalance(call.orgId, chargedCost, isReport ? 1 : 0),
    incrementUsageCounters(call.userId, call.orgId, {
      action: call.action,
      costUsd: chargedCost,
      inputTokens: call.inputTokens,
      outputTokens: call.outputTokens,
    }),
  ]);
}
