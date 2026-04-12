import { deductBalance, getOrgBalance } from "../../db/entities.js";

export type UsageAction = "router" | "fill" | "refine" | "agent_round";

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
  orgId: string;
  action: UsageAction;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Deducts the AI cost of a Bedrock call from the org balance.
 * Does NOT touch the report counter — that is the caller's responsibility
 * (see `incrementReportCount`). Called from TrackedBedrock after each call.
 *
 * Failures must not block the API response — the wrapper swallows and logs.
 */
export async function trackAndDeduct(call: TrackedCall): Promise<void> {
  const chargedCost = calculateCost(call.modelId, call.inputTokens, call.outputTokens) * SPREAD;
  await deductBalance(call.orgId, chargedCost, 0);
}

/**
 * Increments the org's lifetime report counter by one. Called by the fill
 * route after a NEW_FILL stream completes successfully — not on REFINE or
 * RE_SELECT. Kept separate from cost tracking so the decision of what counts
 * as a "report" lives at the route layer (where intent is known), not inside
 * the generic Bedrock wrapper.
 */
export async function incrementReportCount(orgId: string): Promise<void> {
  await deductBalance(orgId, 0, 1);
}
