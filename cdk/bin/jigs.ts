import * as cdk from "aws-cdk-lib";
import { JigsStack } from "../lib/jigs-stack";

const app = new cdk.App();
const stage = app.node.tryGetContext("stage") || "staging";

new JigsStack(app, `Jigs-${stage}`, {
  stage,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: "eu-central-1",
  },
});
