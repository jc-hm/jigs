import * as cdk from "aws-cdk-lib";
import { JigsStack } from "../lib/jigs-stack";

const STAGE_REGION: Record<string, string> = {
  staging: "us-west-2",
  prod: "eu-central-1",
};

const app = new cdk.App();
const stage = app.node.tryGetContext("stage") || "staging";

const region = STAGE_REGION[stage];
if (!region) {
  throw new Error(`Unknown stage "${stage}". Expected: ${Object.keys(STAGE_REGION).join(", ")}`);
}

new JigsStack(app, `Jigs-${stage}`, {
  stage,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region,
  },
});
