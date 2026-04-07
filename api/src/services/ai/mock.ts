import type { AIRouter, AIFiller, FillChunk, RouterResult } from "./types.js";
import type { TemplateTaxonomyEntry } from "../../db/entities.js";

export const mockRouter: AIRouter = {
  async classifyIntent(
    taxonomy: TemplateTaxonomyEntry[],
    userMessage: string,
    _sessionContext?: string,
  ): Promise<RouterResult> {
    const lower = userMessage.toLowerCase();
    if (lower.includes("refine") || lower.includes("change") || lower.includes("modify")) {
      return { intent: "REFINE" };
    }
    if (lower.includes("re-select") || lower.includes("reselect") || lower.includes("different template")) {
      return { intent: "RE_SELECT", templateId: taxonomy[0]?.id };
    }
    if (lower.includes("update template") || lower.includes("add section")) {
      return { intent: "UPDATE_TMPL" };
    }
    return {
      intent: "NEW_FILL",
      templateId: taxonomy[0]?.id,
    };
  },
};

const CANNED_REPORT = `# MRI Knee

## Clinical Information
Left knee pain, rule out internal derangement.

## Technique
MRI of the left knee was performed without intravenous contrast using standard protocol.

## Findings

**ACL:** Intact, normal signal and morphology.
**PCL:** Intact.
**Medial meniscus:** No tear identified.
**Lateral meniscus:** No tear identified.
**MCL:** Intact.
**LCL and posterolateral corner:** Intact.
**Extensor mechanism:** Intact.
**Articular cartilage:** Preserved.
**Bone marrow:** Normal signal.
**Joint effusion:** Small physiologic joint fluid.
**Baker's cyst:** None.
**Surrounding soft tissues:** Unremarkable.

## Impression
Normal MRI of the left knee. No acute abnormality.`;

export const mockFiller: AIFiller = {
  async *streamFillTemplate(
    _skillInstructions: string,
    _skillTone: string,
    _templateContent: string,
    _userDescription: string,
    _conversationHistory?: Array<{ role: "user" | "assistant"; text: string }>,
  ): AsyncGenerator<FillChunk> {
    // Stream the canned report in chunks to exercise the SSE path
    const chunks = CANNED_REPORT.match(/.{1,40}/g) || [CANNED_REPORT];
    for (const chunk of chunks) {
      yield { type: "text", text: chunk };
    }
    yield {
      type: "usage",
      data: {
        inputTokens: 250,
        outputTokens: 180,
        modelId: "mock-model",
      },
    };
  },
};
