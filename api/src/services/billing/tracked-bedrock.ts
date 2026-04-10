import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseStreamCommand,
  type ConverseCommandInput,
  type ConverseCommandOutput,
  type ConverseStreamCommandInput,
  type ConverseStreamOutput,
} from "@aws-sdk/client-bedrock-runtime";
import { config } from "../../env.js";
import {
  assertBalance,
  trackAndDeduct,
  InsufficientBalanceError,
} from "./tracker.js";
import type { UsageAction } from "../../db/entities.js";

export interface CallContext {
  userId: string;
  orgId: string;
  requestId: string;
}

export interface CallMeta {
  action: UsageAction;
  templatePath?: string;
  agentRound?: number;
}

// Single shared SDK client. The wrapper is per-request, but the underlying
// client (with its connection pool, credential cache, etc.) is reused.
let sharedClient: BedrockRuntimeClient | null = null;
function getSharedClient(): BedrockRuntimeClient {
  if (!sharedClient) {
    sharedClient = new BedrockRuntimeClient(
      config.isLocal ? { region: "us-west-2" } : {},
    );
  }
  return sharedClient;
}

/**
 * Per-request wrapper around the Bedrock client. Every call goes through
 * `converse` or `converseStream`, which:
 *   1. Pre-checks the org's balance (throws InsufficientBalanceError if <= 0)
 *   2. Invokes Bedrock
 *   3. Extracts token usage from the response/stream metadata
 *   4. Atomically deducts the marked-up cost from the org balance and
 *      increments per-user/per-org monthly counters
 *
 * AI services (router, filler, agent) take a TrackedBedrock and call its
 * methods instead of the raw SDK, so cost tracking is impossible to forget.
 */
export class TrackedBedrock {
  constructor(
    private readonly ctx: CallContext,
    private readonly client: BedrockRuntimeClient = getSharedClient(),
  ) {}

  async converse(
    input: ConverseCommandInput,
    meta: CallMeta,
  ): Promise<ConverseCommandOutput> {
    await assertBalance(this.ctx.orgId);
    const start = Date.now();
    const response = await this.client.send(new ConverseCommand(input));
    const usage = response.usage;
    if (
      usage?.inputTokens != null &&
      usage?.outputTokens != null &&
      input.modelId
    ) {
      // Fire-and-forget: tracking failures must not break the API response.
      // We still await so the route gets a chance to surface errors during
      // local dev, but production callers can wrap in try/catch if needed.
      try {
        await trackAndDeduct({
          ...this.ctx,
          ...meta,
          modelId: input.modelId,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          durationMs: Date.now() - start,
        });
      } catch (err) {
        console.error("[tracked-bedrock] trackAndDeduct failed:", err);
      }
    }
    return response;
  }

  /**
   * Wraps a streaming Bedrock call. Yields the raw stream events as they
   * arrive (so the caller's existing parsing logic is unchanged) and taps
   * the metadata events to extract token counts. Deduction happens after
   * the stream is fully consumed.
   */
  async *converseStream(
    input: ConverseStreamCommandInput,
    meta: CallMeta,
  ): AsyncGenerator<ConverseStreamOutput> {
    await assertBalance(this.ctx.orgId);
    const start = Date.now();
    const response = await this.client.send(new ConverseStreamCommand(input));

    let inputTokens = 0;
    let outputTokens = 0;

    if (response.stream) {
      for await (const event of response.stream) {
        if (event.metadata?.usage) {
          inputTokens = event.metadata.usage.inputTokens ?? inputTokens;
          outputTokens = event.metadata.usage.outputTokens ?? outputTokens;
        }
        yield event;
      }
    }

    if ((inputTokens > 0 || outputTokens > 0) && input.modelId) {
      try {
        await trackAndDeduct({
          ...this.ctx,
          ...meta,
          modelId: input.modelId,
          inputTokens,
          outputTokens,
          durationMs: Date.now() - start,
        });
      } catch (err) {
        console.error("[tracked-bedrock] trackAndDeduct failed:", err);
      }
    }
  }
}

export { InsufficientBalanceError };
