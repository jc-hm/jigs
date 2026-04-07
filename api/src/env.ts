export type AIProvider = "mock" | "ollama" | "bedrock";

export const config = {
  stage: process.env.STAGE || "local",
  tableName: process.env.TABLE_NAME || "jigs-local",
  templateBucket: process.env.TEMPLATE_BUCKET || "jigs-templates-local",
  cognitoUserPoolId: process.env.COGNITO_USER_POOL_ID || "",
  cognitoClientId: process.env.COGNITO_CLIENT_ID || "",
  isLocal: (process.env.STAGE || "local") === "local",
  aiProvider: (process.env.AI_PROVIDER || "mock") as AIProvider,
  ollamaUrl: process.env.OLLAMA_URL || "http://localhost:11434",
  ollamaModel: process.env.OLLAMA_MODEL || "llama3.1:8b",
};
