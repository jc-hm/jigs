import {
  BedrockRuntimeClient,
  ConverseStreamCommand,
} from "@aws-sdk/client-bedrock-runtime";
import type { AIFiller, FillChunk } from "./types.js";
import { config } from "../../env.js";

const bedrock = new BedrockRuntimeClient(
  config.isLocal ? { region: "us-west-2" } : {}
);

const MODEL_ID = "us.anthropic.claude-sonnet-4-20250514-v1:0";

export const bedrockFiller: AIFiller = {
  async *streamFillTemplate(
    authorInstructions: string,
    templateContent: string,
    userDescription: string,
    conversationHistory?: Array<{ role: "user" | "assistant"; text: string }>,
  ): AsyncGenerator<FillChunk> {
    const systemPrompt = `${authorInstructions}

Template:
${templateContent}

Fill this template based on the user's clinical description. Output only the completed report.`;

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

    const response = await bedrock.send(
      new ConverseStreamCommand({
        modelId: MODEL_ID,
        messages,
        system: [{ text: systemPrompt }],
        inferenceConfig: {
          maxTokens: 4096,
          temperature: 0.3,
        },
      })
    );

    let inputTokens = 0;
    let outputTokens = 0;

    if (response.stream) {
      for await (const event of response.stream) {
        if (event.contentBlockDelta?.delta?.text) {
          yield { type: "text", text: event.contentBlockDelta.delta.text };
        }
        if (event.metadata?.usage) {
          inputTokens = event.metadata.usage.inputTokens ?? 0;
          outputTokens = event.metadata.usage.outputTokens ?? 0;
        }
      }
    }

    yield {
      type: "usage",
      data: { inputTokens, outputTokens, modelId: MODEL_ID },
    };
  },
};
