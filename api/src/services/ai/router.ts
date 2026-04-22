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

Use CLARIFY in two situations:
1. No template is a good match — ask what kind of document the user wants.
2. Two or more templates match equally well AND they differ by a specific qualifier or variant that the user has not mentioned — ask which applies.

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
            maxTokens: 100,
            temperature: 0,
          },
        },
        { action: "router" },
      );

      const text =
        response.output?.message?.content?.[0]?.text || '{"intent": "NEW_FILL"}';

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
