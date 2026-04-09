import {
  BedrockRuntimeClient,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime";
import type { AIRouter, RouterResult } from "./types.js";
import { config } from "../../env.js";

const bedrock = new BedrockRuntimeClient(
  config.isLocal ? { region: "us-west-2" } : {}
);

export function buildRouterPrompt(
  filenames: string[],
  sessionContext?: string,
): string {
  const fileList = filenames.map((f) => `- ${f}`).join("\n");

  return `You are a routing assistant. Classify the user's message into one of these intents:

NEW_FILL — The user wants to generate a new report. Select the best matching template.
REFINE — The user wants to modify the current report (change a finding, fix wording, etc).
RE_SELECT — The user wants a different template for the current study.
UPDATE_TMPL — The user wants to modify the template itself (add/remove sections).

Available templates:
${fileList}

${sessionContext ? `Current session context: ${sessionContext}` : "No active session."}

Respond with JSON only: {"intent": "NEW_FILL", "templateId": "mri-knee.md"} or {"intent": "REFINE"} etc.
If intent is NEW_FILL, you MUST include templateId (the exact filename from the list above). For other intents, templateId is optional.`;
}

export const bedrockRouter: AIRouter = {
  async classifyIntent(
    filenames: string[],
    userMessage: string,
    sessionContext?: string,
  ): Promise<RouterResult> {
    const systemPrompt = buildRouterPrompt(filenames, sessionContext);

    const response = await bedrock.send(
      new ConverseCommand({
        modelId: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
        messages: [{ role: "user", content: [{ text: userMessage }] }],
        system: [{ text: systemPrompt }],
        inferenceConfig: {
          maxTokens: 100,
          temperature: 0,
        },
      })
    );

    const text =
      response.output?.message?.content?.[0]?.text || '{"intent": "NEW_FILL"}';
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
