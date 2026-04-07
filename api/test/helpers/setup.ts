import { seed } from "../../src/db/seed.js";
import { _setAIRouter, _setAIFiller, _resetAI } from "../../src/services/ai/provider.js";
import { mockRouter, mockFiller } from "../../src/services/ai/mock.js";

export async function seedTestData() {
  await seed();
}

export function injectMockAI() {
  _setAIRouter(mockRouter);
  _setAIFiller(mockFiller);
}

export function resetMockAI() {
  _resetAI();
}
