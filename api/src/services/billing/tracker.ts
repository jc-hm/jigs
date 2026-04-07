import { getDailyUsage, incrementUsage } from "../../db/entities.js";

// Model pricing per million tokens (USD)
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "anthropic.claude-haiku-4-5-20251001": { input: 0.8, output: 4.0 },
  "anthropic.claude-sonnet-4-20250514": { input: 3.0, output: 15.0 },
};

export function calculateCost(
  modelId: string,
  inputTokens: number,
  outputTokens: number
): number {
  const pricing = MODEL_PRICING[modelId];
  if (!pricing) return 0;
  return (
    (inputTokens * pricing.input) / 1_000_000 +
    (outputTokens * pricing.output) / 1_000_000
  );
}

const FREE_DAILY_LIMIT = 10;

export async function checkFreeLimit(userId: string): Promise<boolean> {
  const dailyCount = await getDailyUsage(userId);
  return dailyCount < FREE_DAILY_LIMIT;
}

export async function recordUsage(
  userId: string,
  orgId: string,
  modelId: string,
  inputTokens: number,
  outputTokens: number
): Promise<void> {
  const cost = calculateCost(modelId, inputTokens, outputTokens);
  await incrementUsage(userId, orgId, cost);
}
