import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseStreamCommand,
  type ConverseCommandInput,
  type ConverseCommandOutput,
  type ConverseStreamCommandInput,
  type ConverseStreamOutput,
  type Message,
} from "@aws-sdk/client-bedrock-runtime";
import { config } from "../../env.js";
import {
  assertBalance,
  trackAndDeduct,
  calculateCost,
  modelTier,
  InsufficientBalanceError,
} from "./tracker.js";
import type { UsageAction } from "./tracker.js";
import { putUsageEvent } from "./usage-events.js";
import { log, preview } from "../../lib/log.js";

export interface CallContext {
  userId: string;
  orgId: string;
  requestId: string;
  surface: "fill" | "templates";
}

export interface CallMeta {
  action: UsageAction;
  templatePath?: string;
  agentRound?: number;
}

/**
 * Info passed to the optional `onRetry` callback whenever a Bedrock call
 * is about to back off and retry. The route layer relays this to the
 * frontend as an SSE `retry` event so the user can see WHY a request is
 * slow ("retry 3/5 — throttled") instead of staring at a generic spinner.
 */
export interface RetryInfo {
  attempt: number;       // the attempt number that just FAILED (1-based)
  maxAttempts: number;
  errorName: string;
  delayMs: number;       // wall-clock wait until the next attempt
  action: UsageAction;
}

export type RetryCallback = (info: RetryInfo) => Promise<void> | void;

export interface TrackedBedrockOptions {
  /** Called once per retry attempt (NOT on the initial attempt). */
  onRetry?: RetryCallback;
}

// Errors we know are safe to retry on. Matches the set in app.ts that
// the global error handler also recognises — kept in sync intentionally.
const RETRYABLE_BEDROCK_ERRORS = new Set([
  "ThrottlingException",
  "ServiceUnavailableException",
  "ModelStreamErrorException",
  "ModelTimeoutException",
]);

// 1 initial + 9 retries. Previously 5; bumped after a 30-template agent
// request on staging exhausted the budget on Round 4 (`6586f4f7-…`).
// Each round of the agent loop is a single Bedrock call, so a 10-round
// agent with 30 templates makes 10 Sonnet calls in a tight burst that
// can easily trip the cross-region inference profile's short-window
// throttle. More attempts with a longer backoff tail gives us a better
// chance of riding out the burst instead of failing the whole job.
const MAX_RETRY_ATTEMPTS = 10;
const MAX_BACKOFF_MS = 20_000;

/**
 * Exponential backoff with ±20% jitter, capped at MAX_BACKOFF_MS.
 *
 * Base 2s × 3^(attempt-1) so the ramp is:
 *   attempt 1 → 2s
 *   attempt 2 → 6s
 *   attempt 3 → 18s
 *   attempt 4+ → 20s (cap)
 *
 * Previously the ramp started at 1s and doubled (1, 2, 4, 8, 16, 20…),
 * which meant users watching the UI routinely saw 4-5 retry counters tick
 * by during a single throttling incident. The steeper ramp gives Bedrock
 * more headroom between each attempt, so in practice most throttling
 * windows clear by retry 2-3 and the user sees fewer "AI is busy" events.
 * Total budget across 10 attempts ≈ 146s, same order of magnitude as
 * before — well under Lambda's 15-minute ceiling.
 */
function backoffMs(attempt: number): number {
  const base = Math.min(2000 * 3 ** (attempt - 1), MAX_BACKOFF_MS);
  const jitter = base * 0.2 * (Math.random() * 2 - 1);
  return Math.round(base + jitter);
}

// Single shared SDK client. The wrapper is per-request, but the underlying
// client (with its connection pool, credential cache, etc.) is reused.
//
// Retry config: SDK retries are DISABLED (maxAttempts=1) because we
// implement our own retry loop in `retryableSend` below. The reason is
// visibility: the SDK's adaptive retry hides everything inside a single
// `client.send()`, so the user sees a long opaque wait. Our manual loop
// fires `onRetry` callbacks the route relays as SSE events, so the
// frontend can show "AI is busy — retry 3/5".
let sharedClient: BedrockRuntimeClient | null = null;
function getSharedClient(): BedrockRuntimeClient {
  if (!sharedClient) {
    const baseConfig = config.isLocal ? { region: "us-west-2" } : {};
    sharedClient = new BedrockRuntimeClient({
      ...baseConfig,
      maxAttempts: 1,
    });
  }
  return sharedClient;
}

/**
 * Flatten a Bedrock Message[] into a short text preview, joining text and
 * tool blocks. We log a preview rather than full content to keep CloudWatch
 * lines bounded — full transcripts are recoverable from S3 event records
 * later (out of scope for now, see BACKLOG.md).
 */
function messagesPreview(messages: Message[] | undefined): string {
  if (!messages || messages.length === 0) return "";
  const parts: string[] = [];
  for (const m of messages) {
    const blocks = m.content ?? [];
    for (const b of blocks) {
      if ("text" in b && typeof b.text === "string") {
        parts.push(`[${m.role}] ${b.text}`);
      } else if ("toolUse" in b && b.toolUse) {
        parts.push(
          `[${m.role}] tool_use:${b.toolUse.name}(${preview(b.toolUse.input, 200)})`,
        );
      } else if ("toolResult" in b && b.toolResult) {
        const inner = b.toolResult.content
          ?.map((c) => ("text" in c ? c.text : "<non-text>"))
          .join(" ");
        parts.push(`[${m.role}] tool_result: ${preview(inner ?? "", 200)}`);
      }
    }
  }
  return preview(parts.join(" | "), 800);
}

function responsePreview(response: ConverseCommandOutput): string {
  const blocks = response.output?.message?.content ?? [];
  const parts: string[] = [];
  for (const b of blocks) {
    if ("text" in b && typeof b.text === "string") {
      parts.push(b.text);
    } else if ("toolUse" in b && b.toolUse) {
      parts.push(
        `tool_use:${b.toolUse.name}(${preview(b.toolUse.input, 200)})`,
      );
    }
  }
  return preview(parts.join(" "), 800);
}

/**
 * Per-request wrapper around the Bedrock client. Every call goes through
 * `converse` or `converseStream`, which:
 *   1. Pre-checks the org's balance (throws InsufficientBalanceError if <= 0)
 *   2. Invokes Bedrock
 *   3. Extracts token usage from the response/stream metadata
 *   4. Atomically deducts the marked-up cost from the org balance and
 *      increments per-user/per-org monthly counters
 *   5. Logs a structured `bedrock.call` event so every call is queryable
 *      by requestId / action / orgId in CloudWatch Insights
 *
 * AI services (router, filler, agent) take a TrackedBedrock and call its
 * methods instead of the raw SDK, so cost tracking is impossible to forget.
 */
export class TrackedBedrock {
  constructor(
    private readonly ctx: CallContext,
    private readonly options: TrackedBedrockOptions = {},
    private readonly client: BedrockRuntimeClient = getSharedClient(),
  ) {}

  /** Exposed so AI services can include the requestId in their own log lines. */
  get requestId(): string {
    return this.ctx.requestId;
  }
  get userId(): string {
    return this.ctx.userId;
  }
  get orgId(): string {
    return this.ctx.orgId;
  }

  /**
   * Manual retry loop around `client.send()`. Distinguished from SDK
   * retry by the `onRetry` callback, which lets the route layer relay
   * progress to the frontend as the loop runs. Only the call setup is
   * retried — once a streaming response has started, errors mid-stream
   * surface to the caller as-is.
   */
  private async retryableSend<T>(
    sendFn: () => Promise<T>,
    meta: CallMeta,
  ): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
      try {
        return await sendFn();
      } catch (err) {
        lastErr = err;
        const retryable =
          err instanceof Error && RETRYABLE_BEDROCK_ERRORS.has(err.name);
        if (!retryable || attempt >= MAX_RETRY_ATTEMPTS) throw err;

        const delayMs = backoffMs(attempt);
        log.warn("bedrock.retry", {
          requestId: this.ctx.requestId,
          orgId: this.ctx.orgId,
          action: meta.action,
          agentRound: meta.agentRound,
          attempt,
          maxAttempts: MAX_RETRY_ATTEMPTS,
          errorName: (err as Error).name,
          delayMs,
        });

        if (this.options.onRetry) {
          try {
            await this.options.onRetry({
              attempt,
              maxAttempts: MAX_RETRY_ATTEMPTS,
              errorName: (err as Error).name,
              delayMs,
              action: meta.action,
            });
          } catch (cbErr) {
            // The onRetry callback writes to an SSE stream — if that
            // write fails, log it but don't abandon the retry.
            log.error("bedrock.retry.callback_failed", cbErr, {
              requestId: this.ctx.requestId,
              action: meta.action,
            });
          }
        }

        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
    throw lastErr;
  }

  async converse(
    input: ConverseCommandInput,
    meta: CallMeta,
  ): Promise<ConverseCommandOutput> {
    await assertBalance(this.ctx.orgId);
    const start = Date.now();
    let response: ConverseCommandOutput;
    try {
      response = await this.retryableSend(
        () => this.client.send(new ConverseCommand(input)),
        meta,
      );
    } catch (err) {
      // Bedrock errors (throttling, validation, model errors) were
      // previously bubbling up unlogged and surfacing as silent 500s. Log
      // here with full context before rethrowing so the global onError
      // handler also catches them.
      log.error("bedrock.call.failed", err, {
        requestId: this.ctx.requestId,
        userId: this.ctx.userId,
        orgId: this.ctx.orgId,
        action: meta.action,
        modelId: input.modelId,
        agentRound: meta.agentRound,
        durationMs: Date.now() - start,
        inputPreview: messagesPreview(input.messages),
      });
      throw err;
    }

    const usage = response.usage;
    log.bedrock("bedrock.call", {
      requestId: this.ctx.requestId,
      userId: this.ctx.userId,
      orgId: this.ctx.orgId,
      action: meta.action,
      modelId: input.modelId ?? "",
      agentRound: meta.agentRound,
      stopReason: response.stopReason,
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
      durationMs: Date.now() - start,
      inputPreview: messagesPreview(input.messages),
      outputPreview: responsePreview(response),
    });

    if (input.modelId) {
      const inTok  = usage?.inputTokens ?? 0;
      const outTok = usage?.outputTokens ?? 0;
      try {
        const costUsd = await trackAndDeduct({
          orgId: this.ctx.orgId,
          action: meta.action,
          modelId: input.modelId,
          inputTokens: inTok,
          outputTokens: outTok,
        });
        putUsageEvent({
          ts: start,
          req_id: this.ctx.requestId,
          org_id: this.ctx.orgId,
          user_id: this.ctx.userId,
          model_id: input.modelId,
          model_tier: modelTier(input.modelId),
          action: meta.action,
          surface: this.ctx.surface,
          in_tok: inTok,
          out_tok: outTok,
          cost_usd: costUsd,
          lat_ms: Date.now() - start,
        });
      } catch (err) {
        log.error("bedrock.track.failed", err, {
          requestId: this.ctx.requestId,
          orgId: this.ctx.orgId,
          action: meta.action,
        });
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
    let response;
    try {
      response = await this.retryableSend(
        () => this.client.send(new ConverseStreamCommand(input)),
        meta,
      );
    } catch (err) {
      log.error("bedrock.stream.failed", err, {
        requestId: this.ctx.requestId,
        userId: this.ctx.userId,
        orgId: this.ctx.orgId,
        action: meta.action,
        modelId: input.modelId,
        durationMs: Date.now() - start,
        inputPreview: messagesPreview(input.messages),
      });
      throw err;
    }

    let inputTokens = 0;
    let outputTokens = 0;
    let collectedText = "";
    let stopReason: string | undefined;

    // Capture stream errors so we can still track the report count before
    // rethrowing. Without this, a Bedrock mid-stream error (e.g.
    // ModelStreamErrorException) would skip trackAndDeduct entirely and the
    // reportsLifetime counter would never increment even for a fill that
    // produced output up to the failure point.
    let streamErr: unknown;

    if (response.stream) {
      try {
        for await (const event of response.stream) {
          if (event.metadata?.usage) {
            inputTokens = event.metadata.usage.inputTokens ?? inputTokens;
            outputTokens = event.metadata.usage.outputTokens ?? outputTokens;
          }
          if (event.contentBlockDelta?.delta?.text) {
            collectedText += event.contentBlockDelta.delta.text;
          }
          if (event.messageStop?.stopReason) {
            stopReason = event.messageStop.stopReason;
          }
          yield event;
        }
      } catch (err) {
        log.error("bedrock.stream.iter_failed", err, {
          requestId: this.ctx.requestId,
          orgId: this.ctx.orgId,
          action: meta.action,
          modelId: input.modelId,
          durationMs: Date.now() - start,
        });
        streamErr = err;
      }
    }

    log.bedrock("bedrock.stream", {
      requestId: this.ctx.requestId,
      userId: this.ctx.userId,
      orgId: this.ctx.orgId,
      action: meta.action,
      modelId: input.modelId ?? "",
      stopReason,
      inputTokens,
      outputTokens,
      durationMs: Date.now() - start,
      inputPreview: messagesPreview(input.messages),
      outputPreview: preview(collectedText, 800),
    });

    // Track whenever we have token data — cost is what matters here.
    // Report counting is handled at the route level, not here.
    const shouldTrack = input.modelId && (inputTokens > 0 || outputTokens > 0);

    if (shouldTrack) {
      try {
        const costUsd = await trackAndDeduct({
          orgId: this.ctx.orgId,
          action: meta.action,
          modelId: input.modelId!,
          inputTokens,
          outputTokens,
        });
        putUsageEvent({
          ts: start,
          req_id: this.ctx.requestId,
          org_id: this.ctx.orgId,
          user_id: this.ctx.userId,
          model_id: input.modelId!,
          model_tier: modelTier(input.modelId!),
          action: meta.action,
          surface: this.ctx.surface,
          in_tok: inputTokens,
          out_tok: outputTokens,
          cost_usd: costUsd,
          lat_ms: Date.now() - start,
        });
      } catch (err) {
        log.error("bedrock.track.failed", err, {
          requestId: this.ctx.requestId,
          orgId: this.ctx.orgId,
          action: meta.action,
        });
      }
    }

    if (streamErr) throw streamErr;
  }
}

export { InsufficientBalanceError };
