import type { TemplateTaxonomyEntry } from "../../db/entities.js";

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
    taxonomy: TemplateTaxonomyEntry[],
    userMessage: string,
    sessionContext?: string,
  ): Promise<RouterResult>;
}

export interface AIFiller {
  streamFillTemplate(
    skillInstructions: string,
    skillTone: string,
    templateContent: string,
    userDescription: string,
    conversationHistory?: Array<{ role: "user" | "assistant"; text: string }>,
  ): AsyncGenerator<FillChunk>;
}
