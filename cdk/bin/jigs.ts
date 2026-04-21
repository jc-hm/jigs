import * as cdk from "aws-cdk-lib";
import { JigsStack } from "../lib/jigs-stack";

interface StageConfig {
  region: string;
  // System cross-region inference profile IDs. These route within the
  // geographic cluster only — us.* stays in US, eu.* stays in EU.
  // Direct on-demand invocation is not supported for Haiku 4.5 / Sonnet 4.6.
  bedrockModelSonnet: string;
  bedrockModelHaiku: string;
  // JC's Cognito sub UUID for this stage's pool — gates /api/v1/admin/* routes.
  // Get via: aws cognito-idp list-users --user-pool-id <id> --filter 'email = "juanqui.hm@gmail.com"'
  //          --query "Users[0].Attributes[?Name=='sub'].Value" --output text
  // Leave empty string to disable admin access (safe default before lookup).
  superAdminCognitoId: string;
}

const STAGE_CONFIG: Record<string, StageConfig> = {
  staging: {
    region: "us-west-2",
    bedrockModelSonnet: "us.anthropic.claude-sonnet-4-6",
    bedrockModelHaiku:  "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    superAdminCognitoId: "28611350-6061-703f-75dd-de7784ebc6af",
  },
  prod: {
    region: "eu-central-1",
    bedrockModelSonnet: "eu.anthropic.claude-sonnet-4-6",
    bedrockModelHaiku:  "eu.anthropic.claude-haiku-4-5-20251001-v1:0",
    superAdminCognitoId: "c3446892-9071-70b7-ba17-8d3e06251f2e",
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
