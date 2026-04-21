import { deductBalance, getOrgBalance } from "../../db/entities.js";

export type UsageAction = "router" | "fill" | "refine" | "agent_round";
export type ModelTier = "li" | "md";

// Bedrock list-price per million tokens (USD). Update here when AWS changes
// prices — a deploy picks up the change automatically.
const MODEL_PRICING: Record<string, { input: number; output: number; tier: ModelTier }> = {
  "anthropic.claude-haiku-4-5-20251001": { input: 0.8,  output: 4.0,  tier: "li" },
  "anthropic.claude-sonnet-4-20250514":  { input: 3.0,  output: 15.0, tier: "md" },
  "anthropic.claude-sonnet-4-6":         { input: 3.0,  output: 15.0, tier: "md" },
};

/**
 * Markup applied on top of the underlying Bedrock cost when deducting from
 * the org balance. 1.0 = pass-through (no margin). Set this when pricing is
 * decided. Customer-facing price = bedrockCost * SPREAD.
 */
export const SPREAD = 1.0;

function normalizeModelId(modelId: string): string {
  return modelId
    .replace(/^[a-z]{2}\./, "") // strip "us.", "eu." cross-region prefix
    .replace(/-v\d+:\d+$/, ""); // strip "-v1:0" version suffix
}

export function modelTier(modelId: string): ModelTier {
  return MODEL_PRICING[normalizeModelId(modelId)]?.tier ?? "md";
}

export function calculateCost(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const pricing = MODEL_PRICING[normalizeModelId(modelId)];
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
 * Deducts the AI cost of a Bedrock call from the org balance and updates
 * per-tier token counters on the BALANCE row. Returns the charged cost so
 * the caller can include it in the async usage event without recalculating.
 *
 * Failures must not block the API response — the wrapper swallows and logs.
 */
export async function trackAndDeduct(call: TrackedCall): Promise<number> {
  const chargedCost = calculateCost(call.modelId, call.inputTokens, call.outputTokens) * SPREAD;
  const tier = modelTier(call.modelId);
  await deductBalance(call.orgId, chargedCost, 0, {
    tier,
    in: call.inputTokens,
    out: call.outputTokens,
  });
  return chargedCost;
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
