import type { AIRouter, RouterResult } from "./types.js";
import type { TrackedBedrock } from "../billing/tracked-bedrock.js";
import { log } from "../../lib/log.js";

import { config } from "../../env.js";
const MODEL_ID = config.bedrockModelHaiku;

export function buildRouterPrompt(
  filenames: string[],
  sessionContext?: string,
): string {
  const fileList = filenames.map((f) => `- ${f}`).join("\n");

  return `You are a routing assistant. Classify the user's message into one of these intents:

NEW_FILL — The user wants to fill a new document. Select the best matching template.
REFINE — The user wants to modify the current document (change content, fix wording, etc).
RE_SELECT — The user wants a different template for the current task.
UPDATE_TMPL — The user wants to modify the template itself (add/remove sections).
CLARIFY — You cannot confidently pick a single template (no good match, or multiple templates are too similar). Ask the user a short question to disambiguate.

Available templates:
${fileList}

${sessionContext ? `Current session context: ${sessionContext}` : "No active session."}

Respond with JSON only.
- NEW_FILL: {"intent": "NEW_FILL", "templateId": "exact-filename.md"}  (templateId required)
- REFINE/RE_SELECT/UPDATE_TMPL: {"intent": "REFINE"}  (templateId optional)
- CLARIFY: {"intent": "CLARIFY", "message": "Short question for the user — do not mention filenames"}

Use CLARIFY when the best-matching template has qualifiers in its name that the user did not explicitly use in their message. Do not infer unstated qualifiers — ask instead.
When in doubt, prefer CLARIFY over guessing.`;
}

export function makeBedrockRouter(tracker: TrackedBedrock): AIRouter {
  return {
    async classifyIntent(
      filenames: string[],
      userMessage: string,
      sessionContext?: string,
    ): Promise<RouterResult> {
      const systemPrompt = buildRouterPrompt(filenames, sessionContext);

      const response = await tracker.converse(
        {
          modelId: MODEL_ID,
          messages: [{ role: "user", content: [{ text: userMessage }] }],
          system: [{ text: systemPrompt }],
          inferenceConfig: {
            maxTokens: 2000,
            temperature: 1,
          },
          additionalModelRequestFields: {
            thinking: { type: "enabled", budget_tokens: 1024 },
          },
        },
        { action: "router" },
      );

      // With extended thinking, content[0] is the reasoning block — find the text block explicitly.
      const content = response.output?.message?.content ?? [];
      const textBlock = content.find((b) => "text" in b);
      const text = (textBlock && "text" in textBlock ? textBlock.text : null) ?? '{"intent": "NEW_FILL"}';

      log.info("router.classify", {
        requestId: tracker.requestId,
        filenames,
        systemPrompt,
        userMessage,
        rawResponse: text,
      });
      // Extract JSON from response (model may wrap it in markdown code fences)
      const jsonMatch = text.match(/\{[^}]+\}/);
      if (!jsonMatch) {
        return { intent: "NEW_FILL" };
      }

      try {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          intent: parsed.intent || "NEW_FILL",
          templateId: parsed.templateId,
          message: parsed.message,
        };
      } catch {
        return { intent: "NEW_FILL" };
      }
    },
  };
}
