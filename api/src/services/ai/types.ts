export type Intent = "NEW_FILL" | "REFINE" | "RE_SELECT" | "UPDATE_TMPL" | "CLARIFY";

export interface RouterResult {
  intent: Intent;
  templateId?: string;
  message?: string;
}

export interface FillResult {
  inputTokens: number;
  outputTokens: number;
  modelId: string;
}

export type FillChunk =
  | { type: "text"; text: string }
  | { type: "usage"; data: FillResult };

export interface AIRouter {
  classifyIntent(
    filenames: string[],
    userMessage: string,
    sessionContext?: string,
  ): Promise<RouterResult>;
}

export interface AIFiller {
  streamFillTemplate(
    authorInstructions: string,
    templateContent: string,
    userDescription: string,
    conversationHistory?: Array<{ role: "user" | "assistant"; text: string }>,
  ): AsyncGenerator<FillChunk>;
}

/**
 * Events streamed back from the agent loop. The route forwards these
 * over SSE so the frontend can show per-tool progress as the agent works
 * (rather than blocking on a single 95-second JSON response that times
 * out at CloudFront).
 *
 * - `tool`: emitted right after a tool call completes successfully.
 *   Mirrors the old AgentAction shape so the frontend can both display
 *   progress and collect the final action list from the stream.
 * - `retry`: emitted by `TrackedBedrock` when a Bedrock call hits a
 *   retryable error (Throttling/ServiceUnavailable/ModelTimeout) and is
 *   about to back off and retry. The frontend renders an "AI is busy
 *   — retry N/M" indicator so the user understands where the wait is
 *   coming from instead of staring at a generic spinner.
 * - `complete`: terminal event with the agent's natural-language summary
 *   and the list of changed paths (so the frontend can refresh the tree
 *   and select the first changed file, same as before).
 * - `error`: terminal failure inside the loop (e.g. balance ran out
 *   mid-stream). The route also catches these and may convert pre-stream
 *   failures to HTTP errors before any event is sent.
 */
export type AgentEvent =
  | { type: "tool"; tool: string; path?: string; from?: string }
  | {
      type: "retry";
      attempt: number;
      maxAttempts: number;
      errorName: string;
      delayMs: number;
      action: string;
    }
  | { type: "complete"; message: string; changedPaths: string[] }
  | { type: "error"; message: string };

export interface AIAgent {
  executeFileOperations(
    userId: string,
    message: string,
    existingFiles: string[],
    conversationHistory?: Array<{ role: "user" | "assistant"; text: string }>,
  ): AsyncGenerator<AgentEvent>;
}
