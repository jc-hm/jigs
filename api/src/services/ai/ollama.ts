import type {
  AIRouter,
  AIFiller,
  AIAgent,
  AgentEvent,
  FillChunk,
  RouterResult,
} from "./types.js";
import { buildRouterPrompt } from "./router.js";
import { config } from "../../env.js";

const OLLAMA_API = `${config.ollamaUrl}/api/chat`;

interface OllamaStreamChunk {
  message?: { content: string };
  done: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
}

async function ollamaChat(
  request: {
    model: string;
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
    stream: boolean;
    options?: { temperature?: number; num_predict?: number };
  }
): Promise<string> {
  const res = await fetch(OLLAMA_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...request, stream: false }),
    signal: AbortSignal.timeout(600_000), // 10 min for slow local models
  });
  if (!res.ok) {
    throw new Error(`Ollama error ${res.status}: ${await res.text()}`);
  }
  const data = await res.json() as { message: { content: string } };
  return data.message.content;
}

export const ollamaRouter: AIRouter = {
  async classifyIntent(
    filenames: string[],
    userMessage: string,
    sessionContext?: string,
  ): Promise<RouterResult> {
    const systemPrompt = buildRouterPrompt(filenames, sessionContext);

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
      return { intent: "NEW_FILL", templateId: filenames[0] };
    }

    try {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        intent: parsed.intent || "NEW_FILL",
        templateId: parsed.templateId || filenames[0],
        message: parsed.message,
      };
    } catch {
      return { intent: "NEW_FILL", templateId: filenames[0] };
    }
  },
};

export const ollamaAgent: AIAgent = {
  async *executeFileOperations(
    _userId: string,
    message: string,
    existingFiles: string[],
    _conversationHistory?: Array<{ role: "user" | "assistant"; text: string }>,
  ): AsyncGenerator<AgentEvent> {
    // Ollama doesn't do real Bedrock-style tool use here — we just ask
    // for a JSON blob and emit one tool event per action plus a final
    // complete. Same surface as the bedrock impl, lower fidelity inside.
    const systemPrompt = `You are a template file manager. Current files:\n${existingFiles.map(f => `- ${f}`).join("\n")}

Respond with JSON: { "actions": [{"tool": "write_file", "path": "...", "content": "..."}], "message": "what you did" }`;

    const text = await ollamaChat({
      model: config.ollamaModel,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: message },
      ],
      stream: false,
      options: { temperature: 0, num_predict: 16384 },
    });

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      yield { type: "complete", message: "Could not process request", changedPaths: [] };
      return;
    }

    try {
      const parsed = JSON.parse(jsonMatch[0]);
      const actions: Array<{ tool?: string; path?: string }> = parsed.actions || [];
      const changedPaths: string[] = [];
      for (const a of actions) {
        if (a.path) changedPaths.push(a.path);
        yield {
          type: "tool",
          tool: a.tool ?? "unknown",
          path: a.path,
        };
      }
      yield {
        type: "complete",
        message: parsed.message || "Done",
        changedPaths,
      };
    } catch {
      yield { type: "complete", message: "Could not parse response", changedPaths: [] };
    }
  },
};

export const ollamaFiller: AIFiller = {
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
