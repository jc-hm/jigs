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
  InsufficientBalanceError,
} from "./tracker.js";
import type { UsageAction } from "../../db/entities.js";
import { log, preview } from "../../lib/log.js";

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

  async converse(
    input: ConverseCommandInput,
    meta: CallMeta,
  ): Promise<ConverseCommandOutput> {
    await assertBalance(this.ctx.orgId);
    const start = Date.now();
    let response: ConverseCommandOutput;
    try {
      response = await this.client.send(new ConverseCommand(input));
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

    if (
      usage?.inputTokens != null &&
      usage?.outputTokens != null &&
      input.modelId
    ) {
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
        // Tracking failures must not break the API response. Log loudly so
        // we notice in CloudWatch even though we swallow.
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
      response = await this.client.send(new ConverseStreamCommand(input));
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
        throw err;
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
        log.error("bedrock.track.failed", err, {
          requestId: this.ctx.requestId,
          orgId: this.ctx.orgId,
          action: meta.action,
        });
      }
    }
  }
}

export { InsufficientBalanceError };
