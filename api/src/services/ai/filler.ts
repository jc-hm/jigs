import type { AIFiller, FillChunk } from "./types.js";
import type { TrackedBedrock } from "../billing/tracked-bedrock.js";

import { config } from "../../env.js";
const MODEL_ID = config.bedrockModelSonnet;

export function makeBedrockFiller(tracker: TrackedBedrock): AIFiller {
  return {
    async *streamFillTemplate(
      authorInstructions: string,
      templateContent: string,
      userDescription: string,
      conversationHistory?: Array<{ role: "user" | "assistant"; text: string }>,
    ): AsyncGenerator<FillChunk> {
      const systemPrompt = `${authorInstructions}

Template:
${templateContent}

Fill this template based on the user's description. Output only the completed document.`;

      const messages: Array<{
        role: "user" | "assistant";
        content: Array<{ text: string }>;
      }> = [];

      if (conversationHistory) {
        for (const msg of conversationHistory) {
          messages.push({
            role: msg.role,
            content: [{ text: msg.text }],
          });
        }
      }

      messages.push({
        role: "user",
        content: [{ text: userDescription }],
      });

      let inputTokens = 0;
      let outputTokens = 0;

      // The tracker handles cost capture/deduction; we just stream text
      // chunks out and observe the final usage metadata for the legacy
      // FillChunk "usage" event the frontend still consumes.
      for await (const event of tracker.converseStream(
        {
          modelId: MODEL_ID,
          messages,
          system: [{ text: systemPrompt }],
          inferenceConfig: {
            maxTokens: 4096,
            temperature: 0.3,
          },
        },
        { action: "fill" },
      )) {
        if (event.contentBlockDelta?.delta?.text) {
          yield { type: "text", text: event.contentBlockDelta.delta.text };
        }
        if (event.metadata?.usage) {
          inputTokens = event.metadata.usage.inputTokens ?? 0;
          outputTokens = event.metadata.usage.outputTokens ?? 0;
        }
      }

      yield {
        type: "usage",
        data: { inputTokens, outputTokens, modelId: MODEL_ID },
      };
    },
  };
}
