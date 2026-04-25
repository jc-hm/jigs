import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as glue from "aws-cdk-lib/aws-glue";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as targets from "aws-cdk-lib/aws-route53-targets";
import { Construct } from "constructs";

interface JigsStackProps extends cdk.StackProps {
  stage: string;
  // System cross-region inference profile IDs (AWS-managed, not customer-created).
  // These are the only supported invocation path for Haiku 4.5 and Sonnet 4.6 —
  // direct on-demand invocation is not available for these model generations.
  // For prod (eu-central-1): eu.* profiles route within the EU cluster only (GDPR-safe).
  // For staging (us-west-2): us.* profiles route within the US cluster.
  bedrockModelSonnet: string;
  bedrockModelHaiku: string;
  superAdminCognitoId: string;
  sentryDsn: string;
  domainName: string;
  certificate: acm.ICertificate;
}

export class JigsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: JigsStackProps) {
    super(scope, id, props);

    const { stage, bedrockModelSonnet, bedrockModelHaiku, superAdminCognitoId, sentryDsn, domainName, certificate } = props;

    // --- DynamoDB Table (single-table design) ---
    const table = new dynamodb.Table(this, "JigsTable", {
      tableName: `jigs-${stage}`,
      partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "TTL",
      removalPolicy:
        stage === "prod"
          ? cdk.RemovalPolicy.RETAIN
          : cdk.RemovalPolicy.DESTROY,
    });

    // GSI for Cognito ID lookup
    table.addGlobalSecondaryIndex({
      indexName: "GSI1",
      partitionKey: { name: "GSI1PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "GSI1SK", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // GSI for date-sorted feedback queries (avoids table scans in admin)
    table.addGlobalSecondaryIndex({
      indexName: "GSI2",
      partitionKey: { name: "GSI2PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "GSI2SK", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // --- S3 Bucket for usage events (Athena analytics) ---
    const usageBucket = new s3.Bucket(this, "UsageBucket", {
      bucketName: `jigs-usage-${stage}-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy:
        stage === "prod"
          ? cdk.RemovalPolicy.RETAIN
          : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: stage !== "prod",
    });

    // --- Glue Database + Table for Athena ---
    const glueDb = new glue.CfnDatabase(this, "GlueDatabase", {
      catalogId: this.account,
      databaseInput: { name: `jigs_${stage}` },
    });

    new glue.CfnTable(this, "ModelUsageTable", {
      catalogId: this.account,
      databaseName: `jigs_${stage}`,
      tableInput: {
        name: "model_usage",
        tableType: "EXTERNAL_TABLE",
        parameters: {
          // Partition projection: Athena resolves partitions from the path
          // pattern without needing MSCK REPAIR TABLE on every new day.
          "projection.enabled": "true",
          // org_id is injected at query time — caller must supply
          // WHERE org_id = '...' to prune; omitting scans all orgs.
          "projection.org_id.type": "injected",
          "projection.year.type":   "integer",
          "projection.year.range":  "2026,2035",
          "projection.month.type":  "integer",
          "projection.month.range": "1,12",
          "projection.month.digits": "2",
          "projection.day.type":    "integer",
          "projection.day.range":   "1,31",
          "projection.day.digits":  "2",
          "storage.location.template":
            `s3://${usageBucket.bucketName}/events/model_usage/org_id=\${org_id}/year=\${year}/month=\${month}/day=\${day}`,
          "classification": "json",
          "compressionType": "gzip",
        },
        storageDescriptor: {
          location: `s3://${usageBucket.bucketName}/events/model_usage/`,
          inputFormat:  "org.apache.hadoop.mapred.TextInputFormat",
          outputFormat: "org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat",
          compressed: true,
          serdeInfo: {
            serializationLibrary: "org.openx.data.jsonserde.JsonSerDe",
            parameters: { "ignore.malformed.json": "TRUE" },
          },
          columns: [
            { name: "ts",         type: "bigint"  },
            { name: "req_id",     type: "string"  },
            { name: "user_id",    type: "string"  },
            { name: "model_id",   type: "string"  },
            { name: "model_tier", type: "string"  },
            { name: "action",     type: "string"  },
            { name: "surface",    type: "string"  },
            { name: "in_tok",     type: "bigint"  },
            { name: "out_tok",    type: "bigint"  },
            { name: "cost_usd",   type: "double"  },
            { name: "lat_ms",     type: "bigint"  },
          ],
        },
        partitionKeys: [
          { name: "org_id", type: "string" },
          { name: "year",   type: "int"    },
          { name: "month",  type: "int"    },
          { name: "day",    type: "int"    },
        ],
      },
    });

    // --- S3 Bucket for templates ---
    const templateBucket = new s3.Bucket(this, "TemplateBucket", {
      bucketName: `jigs-templates-${stage}-${this.account}`,
      versioned: true,
      removalPolicy:
        stage === "prod"
          ? cdk.RemovalPolicy.RETAIN
          : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: stage !== "prod",
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
    });

    // --- S3 Bucket for web SPA ---
    const webBucket = new s3.Bucket(this, "WebBucket", {
      bucketName: `jigs-web-${stage}-${this.account}`,
      removalPolicy:
        stage === "prod"
          ? cdk.RemovalPolicy.RETAIN
          : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: stage !== "prod",
      // Public read required for S3StaticWebsiteOrigin (website endpoint).
      // Website hosting returns 404 for missing objects (vs 403 with OAI), so
      // the CloudFront error response only needs to handle 404 — API 403s pass
      // through cleanly instead of being replaced with index.html.
      publicReadAccess: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ACLS,
      websiteIndexDocument: "index.html",
    });

    // --- Cognito User Pool ---
    // Note: apiFunction is referenced in lambdaTriggers below, but is defined
    // after this block. CDK resolves the circular reference correctly because
    // lambdaTriggers takes an IFunction (by reference, not by value).
    // We use a Lazy reference via a wrapper to break the forward dependency.
    const userPool = new cognito.UserPool(this, "UserPool", {
      userPoolName: `jigs-${stage}`,
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: {
        email: { required: true, mutable: true },
      },
      customAttributes: {
        // Captured at signup and read by the Post-Confirmation trigger to
        // bootstrap new users with the inviter's templates. Immutable after
        // account creation (Cognito enforces this at the pool level).
        invite_code: new cognito.StringAttribute({ mutable: false }),
      },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: false,
        requireDigits: true,
        requireSymbols: false,
      },
      removalPolicy:
        stage === "prod"
          ? cdk.RemovalPolicy.RETAIN
          : cdk.RemovalPolicy.DESTROY,
    });

    const userPoolClient = new cognito.UserPoolClient(this, "UserPoolClient", {
      userPool,
      userPoolClientName: `jigs-web-${stage}`,
      generateSecret: false,
      authFlows: {
        userSrp: true,
        userPassword: true,
      },
    });

    // --- Lambda Function for API ---
    const apiFunction = new lambda.Function(this, "ApiFunction", {
      functionName: `jigs-api-${stage}`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: "index.handler",
      code: lambda.Code.fromAsset("../api/dist"),
      memorySize: 512,
      // 15 min = Lambda's hard ceiling. Only the agent endpoint runs
      // long — a bulk rename of ~30 templates can take 5-8 minutes of
      // wall clock once Bedrock throttling kicks in on later rounds.
      // Lambda billing is per-execution-ms, not per-configured-timeout,
      // so the only cost of this bump is that a stuck request will take
      // longer to surface as a failure.
      timeout: cdk.Duration.minutes(15),
      architecture: lambda.Architecture.ARM_64,
      environment: {
        STAGE: stage,
        TABLE_NAME: table.tableName,
        TEMPLATE_BUCKET: templateBucket.bucketName,
        COGNITO_USER_POOL_ID: userPool.userPoolId,
        COGNITO_CLIENT_ID: userPoolClient.userPoolClientId,
        BEDROCK_MODEL_SONNET: bedrockModelSonnet,
        BEDROCK_MODEL_HAIKU: bedrockModelHaiku,
        SUPER_ADMIN_COGNITO_ID: superAdminCognitoId,
        USAGE_BUCKET: usageBucket.bucketName,
        SENTRY_DSN: sentryDsn,
      },
    });

    // Lambda Function URL with streaming
    const functionUrl = apiFunction.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
      invokeMode: lambda.InvokeMode.RESPONSE_STREAM,
      cors: {
        allowedOrigins: ["*"],
        allowedMethods: [lambda.HttpMethod.ALL],
        allowedHeaders: ["*"],
      },
    });

    // Grant Lambda access to DynamoDB, S3, and Bedrock
    table.grantReadWriteData(apiFunction);
    templateBucket.grantReadWrite(apiFunction);
    usageBucket.grantWrite(apiFunction);

    apiFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "bedrock:InvokeModel",
          "bedrock:InvokeModelWithResponseStream",
        ],
        resources: ["*"],
      })
    );

    apiFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["cognito-idp:AdminUserGlobalSignOut"],
        resources: [userPool.userPoolArn],
      })
    );

    // Allow the Lambda to invoke itself for async bootstrap jobs (template
    // copy fired by the Post-Confirmation trigger via InvocationType: "Event").
    //
    // We use addToRolePolicy with a concrete ARN string (no CDK token) rather
    // than grantInvoke(apiFunction). grantInvoke creates a self-referential
    // dependency: the role policy references apiFunction.functionArn (a CDK
    // token), which CDK tracks as ServiceRoleDefaultPolicy → ApiFunction, while
    // CDK also tracks ApiFunction → ServiceRoleDefaultPolicy — a cycle.
    // Using a plain string ARN avoids CDK token tracking entirely.
    apiFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["lambda:InvokeFunction"],
        resources: [
          `arn:aws:lambda:${this.region}:${this.account}:function:jigs-api-${stage}`,
        ],
      }),
    );

    // Post-Confirmation trigger — fires after a user verifies their email.
    //
    // We can't use userPool.addTrigger(apiFunction) here because apiFunction
    // already depends on userPool (via COGNITO_USER_POOL_ID env var), and
    // addTrigger would make userPool depend on apiFunction (via functionArn in
    // lambdaConfig), creating a CloudFormation circular dependency.
    //
    // Fix: set lambdaConfig via CfnUserPool escape hatch using a plain-string
    // ARN (no CDK token → no dependency edge), then add the invoke permission
    // as a standalone CfnPermission that is NOT a child of apiFunction.
    // Because this stack has an explicit env (region + account resolved at
    // synth time), the constructed ARN is a concrete string.
    const cfnUserPool = userPool.node.defaultChild as cognito.CfnUserPool;
    cfnUserPool.addPropertyOverride(
      "LambdaConfig.PostConfirmation",
      `arn:aws:lambda:${this.region}:${this.account}:function:jigs-api-${stage}`,
    );

    // Grant Cognito permission to invoke the Lambda.
    // functionName: apiFunction.functionArn (CDK token) creates a natural
    // CfnPermission → ApiFunction dependency so CloudFormation creates the
    // Lambda before the permission — no explicit addDependency needed.
    new lambda.CfnPermission(this, "PostConfirmationTriggerPermission", {
      action: "lambda:InvokeFunction",
      functionName: apiFunction.functionArn,
      principal: "cognito-idp.amazonaws.com",
      sourceArn: userPool.userPoolArn,
    });

    // --- CloudFront Distribution ---
    const distribution = new cloudfront.Distribution(this, "Distribution", {
      domainNames: [domainName],
      certificate,
      defaultBehavior: {
        origin: new origins.S3StaticWebsiteOrigin(webBucket),
        viewerProtocolPolicy:
          cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      additionalBehaviors: {
        "/api/*": {
          origin: new origins.HttpOrigin(
            cdk.Fn.select(2, cdk.Fn.split("/", functionUrl.url))
          ),
          viewerProtocolPolicy:
            cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy:
            cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        },
      },
      defaultRootObject: "index.html",
      errorResponses: [
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: "/index.html",
        },
      ],
    });

    // --- Route 53 alias record ---
    const zone = route53.HostedZone.fromHostedZoneAttributes(this, "Zone", {
      hostedZoneId: "Z00528873B5UC1SJ86NQC",
      zoneName: "rellena.me",
    });

    new route53.ARecord(this, "AliasRecord", {
      zone,
      recordName: domainName,
      target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution)),
    });

    // --- Deploy SPA to web bucket ---
    new s3deploy.BucketDeployment(this, "WebDeploy", {
      sources: [s3deploy.Source.asset("../web/dist")],
      destinationBucket: webBucket,
      distribution,
      distributionPaths: ["/*"],
    });

    // --- Outputs ---
    new cdk.CfnOutput(this, "ApiUrl", { value: functionUrl.url });
    new cdk.CfnOutput(this, "WebUrl", {
      value: `https://${domainName}`,
    });
    new cdk.CfnOutput(this, "UserPoolId", { value: userPool.userPoolId });
    new cdk.CfnOutput(this, "UserPoolClientId", {
      value: userPoolClient.userPoolClientId,
    });
    new cdk.CfnOutput(this, "TableName", { value: table.tableName });
    new cdk.CfnOutput(this, "TemplateBucketName", {
      value: templateBucket.bucketName,
    });
    new cdk.CfnOutput(this, "WebBucketName", { value: webBucket.bucketName });
    new cdk.CfnOutput(this, "DistributionId", {
      value: distribution.distributionId,
    });
  }
}
