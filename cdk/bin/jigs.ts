import * as cdk from "aws-cdk-lib";
import { JigsStack } from "../lib/jigs-stack";

interface StageConfig {
  region: string;
  bedrockModelSonnet: string;
  bedrockModelHaiku: string;
}

const STAGE_CONFIG: Record<string, StageConfig> = {
  staging: {
    region: "us-west-2",
    bedrockModelSonnet: "us.anthropic.claude-sonnet-4-20250514-v1:0",
    bedrockModelHaiku:  "us.anthropic.claude-haiku-4-5-20251001-v1:0",
  },
  prod: {
    region: "eu-central-1",
    bedrockModelSonnet: "eu.anthropic.claude-sonnet-4-20250514-v1:0",
    bedrockModelHaiku:  "eu.anthropic.claude-haiku-4-5-20251001-v1:0",
  },
};

const app = new cdk.App();
const stage = app.node.tryGetContext("stage") || "staging";

const stageConfig = STAGE_CONFIG[stage];
if (!stageConfig) {
  throw new Error(`Unknown stage "${stage}". Expected: ${Object.keys(STAGE_CONFIG).join(", ")}`);
}

new JigsStack(app, `Jigs-${stage}`, {
  stage,
  ...stageConfig,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: stageConfig.region,
  },
});
