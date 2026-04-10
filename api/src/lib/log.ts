/**
 * Structured JSON logger.
 *
 * Every log line is a single JSON object on stdout/stderr. CloudWatch
 * Insights can query by field (e.g. `fields @timestamp, msg, err.stack |
 * filter level = "error" and requestId = "..."`), and `pnpm logs:staging`
 * (see api/scripts/logs.ts) makes per-request investigation a one-liner.
 *
 * Conventions:
 *   log.info("router.classify", { requestId, action, ... })
 *   log.bedrock(...) — specialized helper for Bedrock calls (always logs
 *     model, tokens, duration, action, requestId so we can correlate cost
 *     and latency without ad-hoc parsing).
 *   log.error("agent.round.failed", err, { requestId, round })
 *
 * The first arg is a stable event name (snake.case), not a sentence —
 * makes filtering with `msg = "agent.round.failed"` reliable.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogContext {
  requestId?: string;
  userId?: string;
  orgId?: string;
  route?: string;
  [key: string]: unknown;
}

function emit(level: LogLevel, msg: string, context: LogContext): void {
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...context,
  };
  // CloudWatch picks up stdout/stderr. JSON Lines lets Insights query by
  // field. Errors go to stderr so they show up in CloudWatch as ERROR-level
  // entries (Lambda's runtime classifies based on the stream).
  const line = JSON.stringify(entry);
  if (level === "error" || level === "warn") {
    console.error(line);
  } else {
    console.log(line);
  }
}

function errFields(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return {
      errName: err.name,
      errMessage: err.message,
      errStack: err.stack,
    };
  }
  return { errMessage: String(err) };
}

/**
 * Truncate long strings to keep log lines bounded. CloudWatch caps individual
 * log events at ~256KB; in practice we want previews, not full payloads, so
 * the LLM transcript stays grep-able rather than overwhelming the log volume.
 */
export function preview(value: unknown, maxLen = 500): string {
  const str = typeof value === "string" ? value : JSON.stringify(value);
  if (str.length <= maxLen) return str;
  return `${str.slice(0, maxLen)}…(+${str.length - maxLen} chars)`;
}

export const log = {
  debug(msg: string, context: LogContext = {}): void {
    emit("debug", msg, context);
  },
  info(msg: string, context: LogContext = {}): void {
    emit("info", msg, context);
  },
  warn(msg: string, context: LogContext = {}): void {
    emit("warn", msg, context);
  },
  error(msg: string, err: unknown, context: LogContext = {}): void {
    emit("error", msg, { ...context, ...errFields(err) });
  },
  /**
   * Log a Bedrock call. Centralized so every site captures the same fields
   * — modelId, tokens, duration, action, requestId — making cost analysis
   * by `action` and per-request drilldown trivial.
   */
  bedrock(
    msg: string,
    fields: {
      requestId?: string;
      userId?: string;
      orgId?: string;
      action: string;
      modelId: string;
      inputTokens?: number;
      outputTokens?: number;
      durationMs?: number;
      stopReason?: string;
      [key: string]: unknown;
    }
  ): void {
    emit("info", msg, fields);
  },
};
