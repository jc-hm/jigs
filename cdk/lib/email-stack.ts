import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as ses from "aws-cdk-lib/aws-ses";
import * as sesActions from "aws-cdk-lib/aws-ses-actions";
import { Construct } from "constructs";
import * as path from "path";

const HOSTED_ZONE_ID = "Z00528873B5UC1SJ86NQC";
const APEX_DOMAIN = "rellena.me";

// SES email receiving is only available in certain regions.
// This stack is always deployed to us-east-1.
const SES_INBOUND_ENDPOINT = "inbound-smtp.us-east-1.amazonaws.com";

interface EmailStackProps extends cdk.StackProps {
  // Gmail address that receives all forwarded email for both stages.
  forwardTo: string;
}

export class EmailStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: EmailStackProps) {
    super(scope, id, props);

    const zone = route53.PublicHostedZone.fromPublicHostedZoneAttributes(
      this,
      "Zone",
      { hostedZoneId: HOSTED_ZONE_ID, zoneName: APEX_DOMAIN },
    );

    // ── SES domain identities ─────────────────────────────────────────────────

    // Apex identity: auto-adds SES verification + DKIM CNAMEs via Route53.
    const apexIdentity = new ses.EmailIdentity(this, "ApexIdentity", {
      identity: ses.Identity.publicHostedZone(zone),
    });
    // Suppress unused-variable warning — the identity must exist for SES to
    // accept mail and for DKIM records to be created.
    void apexIdentity;

    // Staging subdomain identity: DKIM records added manually below.
    const stagingIdentity = new ses.EmailIdentity(this, "StagingIdentity", {
      identity: ses.Identity.domain(`staging.${APEX_DOMAIN}`),
    });

    // DKIM CNAMEs for staging.rellena.me
    stagingIdentity.dkimRecords.forEach((record: { name: string; value: string }, i: number) => {
      new route53.CnameRecord(this, `StagingDkim${i}`, {
        zone,
        recordName: record.name,
        domainName: record.value,
        ttl: cdk.Duration.hours(1),
      });
    });

    // ── DNS records ───────────────────────────────────────────────────────────

    // Apex MX — routes inbound email to SES
    new route53.MxRecord(this, "ApexMx", {
      zone,
      values: [{ hostName: SES_INBOUND_ENDPOINT, priority: 10 }],
      ttl: cdk.Duration.hours(1),
    });

    // Staging MX — routes inbound email for staging.rellena.me to SES
    new route53.MxRecord(this, "StagingMx", {
      zone,
      recordName: "staging",
      values: [{ hostName: SES_INBOUND_ENDPOINT, priority: 10 }],
      ttl: cdk.Duration.hours(1),
    });

    // SPF: authorise SES to send from both domains.
    // If a TXT record already exists at the apex, merge its values manually.
    new route53.TxtRecord(this, "ApexSpf", {
      zone,
      values: ["v=spf1 include:amazonses.com ~all"],
      ttl: cdk.Duration.hours(1),
    });

    new route53.TxtRecord(this, "StagingSpf", {
      zone,
      recordName: "staging",
      values: ["v=spf1 include:amazonses.com ~all"],
      ttl: cdk.Duration.hours(1),
    });

    // DMARC — monitoring mode; tighten p= once deliverability looks good.
    new route53.TxtRecord(this, "ApexDmarc", {
      zone,
      recordName: "_dmarc",
      values: [`v=DMARC1; p=none; rua=mailto:ayuda@${APEX_DOMAIN}`],
      ttl: cdk.Duration.hours(1),
    });

    new route53.TxtRecord(this, "StagingDmarc", {
      zone,
      recordName: `_dmarc.staging`,
      values: [`v=DMARC1; p=none; rua=mailto:ayuda@staging.${APEX_DOMAIN}`],
      ttl: cdk.Duration.hours(1),
    });

    // ── S3 bucket for raw inbound email ───────────────────────────────────────

    const emailBucket = new s3.Bucket(this, "EmailBucket", {
      bucketName: `jigs-inbound-email-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      // Raw emails are only needed until the forwarder Lambda processes them.
      lifecycleRules: [{ expiration: cdk.Duration.days(7) }],
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // SES needs permission to write received emails into the bucket.
    emailBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: "AllowSESPuts",
        principals: [new iam.ServicePrincipal("ses.amazonaws.com")],
        actions: ["s3:PutObject"],
        resources: [`${emailBucket.bucketArn}/incoming/*`],
        conditions: { StringEquals: { "aws:SourceAccount": this.account } },
      }),
    );

    // ── Lambda forwarder ──────────────────────────────────────────────────────

    const forwarderFn = new nodejs.NodejsFunction(this, "Forwarder", {
      entry: path.join(__dirname, "../lambda/email-forwarder/index.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      // Cap concurrent executions so a spam burst can't drive up SES send costs.
      // SES invokes Lambda async so excess invocations are queued/dropped, not errored.
      reservedConcurrentExecutions: 5,
      environment: {
        BUCKET: emailBucket.bucketName,
        FORWARD_TO: props.forwardTo,
        DEFAULT_FROM: `ayuda@${APEX_DOMAIN}`,
      },
      bundling: {
        // AWS SDK v3 is provided by the Lambda runtime — exclude from bundle.
        externalModules: ["@aws-sdk/*"],
      },
    });

    emailBucket.grantRead(forwarderFn);

    // Allow SES to invoke the Lambda asynchronously.
    forwarderFn.addPermission("SESInvoke", {
      principal: new iam.ServicePrincipal("ses.amazonaws.com"),
      sourceAccount: this.account,
    });

    forwarderFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ses:SendRawEmail"],
        resources: ["*"],
      }),
    );

    // ── SES receipt rule set ──────────────────────────────────────────────────

    const ruleSet = new ses.ReceiptRuleSet(this, "RuleSet", {
      receiptRuleSetName: "jigs-inbound",
    });

    // Only one rule set can be active per region per account.
    // CDK removed the L1 wrapper for this resource; use CfnResource directly.
    new cdk.CfnResource(this, "ActiveRuleSet", {
      type: "AWS::SES::ReceiptActiveRuleSet",
      properties: { RuleSetName: ruleSet.receiptRuleSetName },
    });

    // Shared actions: store raw email in S3 first, then invoke forwarder.
    // Order matters — S3 must precede Lambda so the file exists when Lambda runs.
    const sharedActions: ses.IReceiptRuleAction[] = [
      new sesActions.S3({ bucket: emailBucket, objectKeyPrefix: "incoming/" }),
      new sesActions.Lambda({
        function: forwarderFn,
        invocationType: sesActions.LambdaInvocationType.EVENT,
      }),
    ];

    ruleSet.addRule("ForwardAyudaProd", {
      recipients: [`ayuda@${APEX_DOMAIN}`],
      actions: sharedActions,
      scanEnabled: true,
    });

    ruleSet.addRule("ForwardAyudaStaging", {
      recipients: [`ayuda@staging.${APEX_DOMAIN}`],
      actions: sharedActions,
      scanEnabled: true,
    });

    // ── IAM user for Gmail "Send as" (SMTP) ───────────────────────────────────

    const smtpUser = new iam.User(this, "SmtpUser", {
      userName: "jigs-smtp-ayuda",
    });

    smtpUser.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ses:SendRawEmail"],
        resources: ["*"],
        conditions: {
          StringLike: {
            "ses:FromAddress": [
              `ayuda@${APEX_DOMAIN}`,
              `ayuda@staging.${APEX_DOMAIN}`,
            ],
          },
        },
      }),
    );

    // ── Outputs ───────────────────────────────────────────────────────────────

    new cdk.CfnOutput(this, "SmtpEndpoint", {
      value: `email-smtp.${this.region}.amazonaws.com`,
      description: "SES SMTP endpoint for Gmail Send-As",
    });

    new cdk.CfnOutput(this, "GmailSendAsSetup", {
      description: "Steps to configure Gmail Send-As for ayuda@rellena.me",
      value: [
        "1. SES console → SMTP Settings → Create SMTP credentials for jigs-smtp-ayuda",
        "2. Gmail → Settings → Accounts → Add another email address → ayuda@rellena.me",
        `3. SMTP server: email-smtp.${this.region}.amazonaws.com, Port: 587, TLS`,
        "4. Enter SMTP username + password from step 1",
        "5. Gmail sends a verification email — it will arrive forwarded to your inbox; click the link",
      ].join(" | "),
    });
  }
}
