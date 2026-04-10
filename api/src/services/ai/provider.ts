import type { AIRouter, AIFiller, AIAgent } from "./types.js";
import { config } from "../../env.js";
import type { AIProvider } from "../../env.js";
import type { TrackedBedrock } from "../billing/tracked-bedrock.js";

// Mock and Ollama services don't depend on the per-request tracker (they
// have no real cost), so we memoize them. The Bedrock services are built
// per-request because they close over the TrackedBedrock instance.
let mockOrOllamaRouter: AIRouter | null = null;
let mockOrOllamaFiller: AIFiller | null = null;
let mockOrOllamaAgent: AIAgent | null = null;

// Test override slots — bypasses provider resolution entirely.
let injectedRouter: AIRouter | null = null;
let injectedFiller: AIFiller | null = null;
let injectedAgent: AIAgent | null = null;

function resolveProvider(): AIProvider {
  // Deployed mode always uses Bedrock
  if (!config.isLocal) return "bedrock";
  // Local mode uses AI_PROVIDER env var (default: mock)
  return config.aiProvider;
}

export async function getAIRouter(tracker?: TrackedBedrock): Promise<AIRouter> {
  if (injectedRouter) return injectedRouter;

  const provider = resolveProvider();
  if (provider === "bedrock") {
    if (!tracker) {
      throw new Error("Bedrock router requires a TrackedBedrock instance");
    }
    const { makeBedrockRouter } = await import("./router.js");
    return makeBedrockRouter(tracker);
  }

  if (!mockOrOllamaRouter) {
    if (provider === "ollama") {
      const { ollamaRouter } = await import("./ollama.js");
      mockOrOllamaRouter = ollamaRouter;
    } else {
      const { mockRouter } = await import("./mock.js");
      mockOrOllamaRouter = mockRouter;
    }
  }
  return mockOrOllamaRouter;
}

export async function getAIFiller(tracker?: TrackedBedrock): Promise<AIFiller> {
  if (injectedFiller) return injectedFiller;

  const provider = resolveProvider();
  if (provider === "bedrock") {
    if (!tracker) {
      throw new Error("Bedrock filler requires a TrackedBedrock instance");
    }
    const { makeBedrockFiller } = await import("./filler.js");
    return makeBedrockFiller(tracker);
  }

  if (!mockOrOllamaFiller) {
    if (provider === "ollama") {
      const { ollamaFiller } = await import("./ollama.js");
      mockOrOllamaFiller = ollamaFiller;
    } else {
      const { mockFiller } = await import("./mock.js");
      mockOrOllamaFiller = mockFiller;
    }
  }
  return mockOrOllamaFiller;
}

export async function getAIAgent(tracker?: TrackedBedrock): Promise<AIAgent> {
  if (injectedAgent) return injectedAgent;

  const provider = resolveProvider();
  if (provider === "bedrock") {
    if (!tracker) {
      throw new Error("Bedrock agent requires a TrackedBedrock instance");
    }
    const { makeBedrockAgent } = await import("./agent.js");
    return makeBedrockAgent(tracker);
  }

  if (!mockOrOllamaAgent) {
    if (provider === "ollama") {
      const { ollamaAgent } = await import("./ollama.js");
      mockOrOllamaAgent = ollamaAgent;
    } else {
      const { mockAgent } = await import("./mock.js");
      mockOrOllamaAgent = mockAgent;
    }
  }
  return mockOrOllamaAgent;
}

// For tests: inject custom implementations
export function _setAIRouter(r: AIRouter) { injectedRouter = r; }
export function _setAIFiller(f: AIFiller) { injectedFiller = f; }
export function _setAIAgent(a: AIAgent) { injectedAgent = a; }
export function _resetAI() {
  injectedRouter = null;
  injectedFiller = null;
  injectedAgent = null;
  mockOrOllamaRouter = null;
  mockOrOllamaFiller = null;
  mockOrOllamaAgent = null;
}
