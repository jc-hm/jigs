export type AIProvider = "mock" | "ollama" | "bedrock";

export const config = {
  stage: process.env.STAGE || "local",
  region: process.env.AWS_REGION || "us-west-2",
  tableName: process.env.TABLE_NAME || "jigs-local",
  templateBucket: process.env.TEMPLATE_BUCKET || "jigs-templates-local",
  cognitoUserPoolId: process.env.COGNITO_USER_POOL_ID || "",
  cognitoClientId: process.env.COGNITO_CLIENT_ID || "",
  // Explicit opt-in only. Missing STAGE defaults to requiring auth (fail closed).
  isLocal: process.env.STAGE === "local",
  aiProvider: (process.env.AI_PROVIDER || "mock") as AIProvider,
  ollamaUrl: process.env.OLLAMA_URL || "http://localhost:11434",
  ollamaModel: process.env.OLLAMA_MODEL || "llama3.1:8b",
  // Bedrock model IDs — injected by CDK with the correct regional prefix.
  // Defaults here are for local dev (only used when AI_PROVIDER=bedrock locally).
  bedrockModelSonnet: process.env.BEDROCK_MODEL_SONNET || "us.anthropic.claude-sonnet-4-20250514-v1:0",
  bedrockModelHaiku: process.env.BEDROCK_MODEL_HAIKU || "us.anthropic.claude-haiku-4-5-20251001-v1:0",
  superAdminCognitoId: process.env.SUPER_ADMIN_COGNITO_ID || "",
};
