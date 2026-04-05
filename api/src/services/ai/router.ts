import {
  BedrockRuntimeClient,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime";
import type { TemplateTaxonomyEntry } from "../../db/entities.js";

const bedrock = new BedrockRuntimeClient({ region: "eu-central-1" });

export type Intent = "NEW_FILL" | "REFINE" | "RE_SELECT" | "UPDATE_TMPL";

export interface RouterResult {
  intent: Intent;
  templateId?: string;
  message?: string;
}

export async function classifyIntent(
  taxonomy: TemplateTaxonomyEntry[],
  userMessage: string,
  sessionContext?: string
): Promise<RouterResult> {
  const taxonomyList = taxonomy
    .map((t) => `- ${t.id}: ${t.name} — ${t.description}`)
    .join("\n");

  const systemPrompt = `You are a routing assistant. Classify the user's message into one of these intents:

NEW_FILL — The user wants to generate a new report. Select the best matching template.
REFINE — The user wants to modify the current report (change a finding, fix wording, etc).
RE_SELECT — The user wants a different template for the current study.
UPDATE_TMPL — The user wants to modify the template itself (add/remove sections).

Available templates:
${taxonomyList}

${sessionContext ? `Current session context: ${sessionContext}` : "No active session."}

Respond with JSON only: {"intent": "NEW_FILL", "templateId": "mri-knee"} or {"intent": "REFINE"} etc.
If intent is NEW_FILL, you MUST include templateId. For other intents, templateId is optional.`;

  const response = await bedrock.send(
    new ConverseCommand({
      modelId: "anthropic.claude-haiku-4-5-20251001",
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

  try {
    const parsed = JSON.parse(text);
    return {
      intent: parsed.intent || "NEW_FILL",
      templateId: parsed.templateId,
      message: parsed.message,
    };
  } catch {
    return { intent: "NEW_FILL" };
  }
}
