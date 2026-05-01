import * as cdk from "aws-cdk-lib";
import { JigsStack } from "../lib/jigs-stack";
import { CertStack } from "../lib/cert-stack";
import { MonitoringStack } from "../lib/monitoring-stack";

// Sentry DSN is shared across stages — the same project, distinguished by
// the `environment` tag (staging vs prod). Browser DSNs are intentionally
// public; Lambda DSN is kept here alongside other non-secret config.
const SENTRY_DSN =
  "https://69b42f4f1b805a644c2d1f42e3ccf3e2@o4511256560926720.ingest.de.sentry.io/4511256573116496";

const ALERT_EMAIL = "chasinglavidainvestments@gmail.com";

interface StageConfig {
  region: string;
  // System cross-region inference profile IDs. These route within the
  // geographic cluster only — us.* stays in US, eu.* stays in EU.
  // Direct on-demand invocation is not supported for Haiku 4.5 / Sonnet 4.6.
  bedrockModelSonnet: string;
  bedrockModelHaiku: string;
  // Cognito sub UUID for the super-admin account — gates /api/v1/admin/* routes.
  // Get via: aws cognito-idp list-users --user-pool-id <id> --filter 'email = "<admin-email>"'
  //          --query "Users[0].Attributes[?Name=='sub'].Value" --output text
  superAdminCognitoId: string;
  domainName: string;
  // CloudFront distribution ID — stable per stage, needed for the us-east-1
  // monitoring stack (CloudFront metrics only exist there).
  cfDistributionId: string;
}

const STAGE_CONFIG: Record<string, StageConfig> = {
  staging: {
    region: "us-west-2",
    bedrockModelSonnet: "us.anthropic.claude-sonnet-4-6",
    bedrockModelHaiku:  "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    superAdminCognitoId: "28611350-6061-703f-75dd-de7784ebc6af",
    domainName: "staging.rellena.me",
    cfDistributionId: "E2W53HMVR4JE8R",
  },
  prod: {
    region: "eu-central-1",
    bedrockModelSonnet: "eu.anthropic.claude-sonnet-4-6",
    bedrockModelHaiku:  "eu.anthropic.claude-haiku-4-5-20251001-v1:0",
    superAdminCognitoId: "c3446892-9071-70b7-ba17-8d3e06251f2e",
    domainName: "rellena.me",
    cfDistributionId: "ETPRLZ1VT6U6L",
  },
};

const app = new cdk.App();
const stage = app.node.tryGetContext("stage") || "staging";

const stageConfig = STAGE_CONFIG[stage];
if (!stageConfig) {
  throw new Error(`Unknown stage "${stage}". Expected: ${Object.keys(STAGE_CONFIG).join(", ")}`);
}

// CloudFront certs must live in us-east-1. Each stage gets its own cert stack
// so staging and prod deploys never share cross-region export writers — a shared
// stack would stomp each other's ExportsWriter on every alternating deploy.
const certStack = new CertStack(app, `Jigs-cert-${stage}`, {
  domainName: stageConfig.domainName,
  subjectAlternativeNames: stage === "prod" ? [`*.${stageConfig.domainName}`] : undefined,
  crossRegionReferences: true,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: "us-east-1",
  },
});

const { cfDistributionId, ...jigsProps } = stageConfig;

new JigsStack(app, `Jigs-${stage}`, {
  stage,
  ...jigsProps,
  sentryDsn: SENTRY_DSN,
  alertEmail: ALERT_EMAIL,
  certificate: certStack.certificate,
  crossRegionReferences: true,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: stageConfig.region,
  },
});

new MonitoringStack(app, `Jigs-monitoring-${stage}`, {
  stage,
  distributionId: cfDistributionId,
  alertEmail: ALERT_EMAIL,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: "us-east-1",
  },
});
