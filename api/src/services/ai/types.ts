import type { AgentResult } from "../files/types.js";

export type Intent = "NEW_FILL" | "REFINE" | "RE_SELECT" | "UPDATE_TMPL";

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

export interface AIAgent {
  executeFileOperations(
    userId: string,
    message: string,
    existingFiles: string[],
    conversationHistory?: Array<{ role: "user" | "assistant"; text: string }>,
  ): Promise<AgentResult>;
}
