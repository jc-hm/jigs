import type { AIRouter, AIFiller, FillChunk, RouterResult } from "./types.js";
import type { TemplateTaxonomyEntry } from "../../db/entities.js";
import { buildRouterPrompt } from "./router.js";
import { config } from "../../env.js";

const OLLAMA_API = `${config.ollamaUrl}/api/chat`;

interface OllamaChatRequest {
  model: string;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  stream: boolean;
  options?: { temperature?: number; num_predict?: number };
}

interface OllamaStreamChunk {
  message?: { content: string };
  done: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
}

async function ollamaChat(
  request: OllamaChatRequest
): Promise<string> {
  const res = await fetch(OLLAMA_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...request, stream: false }),
  });
  if (!res.ok) {
    throw new Error(`Ollama error ${res.status}: ${await res.text()}`);
  }
  const data = await res.json() as { message: { content: string } };
  return data.message.content;
}

export const ollamaRouter: AIRouter = {
  async classifyIntent(
    taxonomy: TemplateTaxonomyEntry[],
    userMessage: string,
    sessionContext?: string,
  ): Promise<RouterResult> {
    const systemPrompt = buildRouterPrompt(taxonomy, sessionContext);

    const text = await ollamaChat({
      model: config.ollamaModel,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      stream: false,
      options: { temperature: 0, num_predict: 100 },
    });

    // Extract JSON from response (model may wrap it in markdown)
    const jsonMatch = text.match(/\{[^}]+\}/);
    if (!jsonMatch) {
      return { intent: "NEW_FILL", templateId: taxonomy[0]?.id };
    }

    try {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        intent: parsed.intent || "NEW_FILL",
        templateId: parsed.templateId || taxonomy[0]?.id,
        message: parsed.message,
      };
    } catch {
      return { intent: "NEW_FILL", templateId: taxonomy[0]?.id };
    }
  },
};

export const ollamaFiller: AIFiller = {
  async *streamFillTemplate(
    skillInstructions: string,
    skillTone: string,
    templateContent: string,
    userDescription: string,
    conversationHistory?: Array<{ role: "user" | "assistant"; text: string }>,
  ): AsyncGenerator<FillChunk> {
    const systemPrompt = `${skillInstructions}

Tone: ${skillTone}

Template:
${templateContent}

Fill this template based on the user's clinical description. Output only the completed report.`;

    const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
      { role: "system", content: systemPrompt },
    ];

    if (conversationHistory) {
      for (const msg of conversationHistory) {
        messages.push({ role: msg.role, content: msg.text });
      }
    }

    messages.push({ role: "user", content: userDescription });

    const res = await fetch(OLLAMA_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.ollamaModel,
        messages,
        stream: true,
        options: { temperature: 0.3, num_predict: 4096 },
      }),
    });

    if (!res.ok) {
      throw new Error(`Ollama error ${res.status}: ${await res.text()}`);
    }

    let inputTokens = 0;
    let outputTokens = 0;
    const reader = res.body?.getReader();
    if (!reader) throw new Error("No response body from Ollama");

    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Ollama streams newline-delimited JSON
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        const chunk = JSON.parse(line) as OllamaStreamChunk;

        if (chunk.message?.content) {
          yield { type: "text", text: chunk.message.content };
        }

        if (chunk.done) {
          inputTokens = chunk.prompt_eval_count ?? 0;
          outputTokens = chunk.eval_count ?? 0;
        }
      }
    }

    // Process any remaining buffer
    if (buffer.trim()) {
      const chunk = JSON.parse(buffer) as OllamaStreamChunk;
      if (chunk.message?.content) {
        yield { type: "text", text: chunk.message.content };
      }
      if (chunk.done) {
        inputTokens = chunk.prompt_eval_count ?? 0;
        outputTokens = chunk.eval_count ?? 0;
      }
    }

    yield {
      type: "usage",
      data: { inputTokens, outputTokens, modelId: `ollama:${config.ollamaModel}` },
    };
  },
};
