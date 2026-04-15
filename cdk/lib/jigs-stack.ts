import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import { Construct } from "constructs";

interface JigsStackProps extends cdk.StackProps {
  stage: string;
}

export class JigsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: JigsStackProps) {
    super(scope, id, props);

    const { stage } = props;

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
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
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

    apiFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "bedrock:InvokeModel",
          "bedrock:InvokeModelWithResponseStream",
        ],
        resources: ["*"],
      })
    );

    // Allow the Lambda to invoke itself for async bootstrap jobs (template
    // copy fired by the Post-Confirmation trigger via InvocationType: "Event").
    apiFunction.grantInvoke(apiFunction);

    // Post-Confirmation trigger — fires after a user verifies their email.
    // CDK automatically adds the Cognito → Lambda invoke permission.
    userPool.addTrigger(
      cognito.UserPoolOperation.POST_CONFIRMATION,
      apiFunction,
    );

    // --- CloudFront Distribution ---
    const oai = new cloudfront.OriginAccessIdentity(this, "WebOAI");
    webBucket.grantRead(oai);

    const distribution = new cloudfront.Distribution(this, "Distribution", {
      defaultBehavior: {
        origin: new origins.S3Origin(webBucket, {
          originAccessIdentity: oai,
        }),
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
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: "/index.html",
        },
      ],
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
      value: `https://${distribution.distributionDomainName}`,
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
