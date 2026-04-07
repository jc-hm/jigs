import type { AIRouter, AIFiller } from "./types.js";
import { config } from "../../env.js";
import type { AIProvider } from "../../env.js";

let router: AIRouter | null = null;
let filler: AIFiller | null = null;

function resolveProvider(): AIProvider {
  // Deployed mode always uses Bedrock
  if (!config.isLocal) return "bedrock";
  // Local mode uses AI_PROVIDER env var (default: mock)
  return config.aiProvider;
}

export async function getAIRouter(): Promise<AIRouter> {
  if (!router) {
    const provider = resolveProvider();
    switch (provider) {
      case "ollama": {
        const { ollamaRouter } = await import("./ollama.js");
        router = ollamaRouter;
        break;
      }
      case "bedrock": {
        const { bedrockRouter } = await import("./router.js");
        router = bedrockRouter;
        break;
      }
      default: {
        const { mockRouter } = await import("./mock.js");
        router = mockRouter;
      }
    }
  }
  return router;
}

export async function getAIFiller(): Promise<AIFiller> {
  if (!filler) {
    const provider = resolveProvider();
    switch (provider) {
      case "ollama": {
        const { ollamaFiller } = await import("./ollama.js");
        filler = ollamaFiller;
        break;
      }
      case "bedrock": {
        const { bedrockFiller } = await import("./filler.js");
        filler = bedrockFiller;
        break;
      }
      default: {
        const { mockFiller } = await import("./mock.js");
        filler = mockFiller;
      }
    }
  }
  return filler;
}

// For tests: inject custom implementations
export function _setAIRouter(r: AIRouter) { router = r; }
export function _setAIFiller(f: AIFiller) { filler = f; }
export function _resetAI() { router = null; filler = null; }
