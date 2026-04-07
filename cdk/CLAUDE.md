# CDK — AWS Infrastructure

AWS CDK (TypeScript) managing all cloud resources. Single stack deployed per stage.

## Architecture Decisions

- **CDK over Terraform/SST** — TypeScript (same as app), AWS-native, no YAML/HCL. First-party AWS support.
- **Single stack** — `JigsStack` contains all resources. Split into multiple stacks only when deploy times become an issue.
- **Stage-based isolation** — `--context stage=staging|prod` creates completely separate resources. Resource names include the stage suffix.
- **Region per stage** — staging deploys to `us-west-2` (Oregon, near dev in Seattle), prod deploys to `eu-central-1` (Frankfurt, near first market Spain). Region mapped from stage name in `bin/jigs.ts`.

## Resources Created

- **DynamoDB** table (`jigs-{stage}`) — single-table design with GSI1 for Cognito ID lookup. PAY_PER_REQUEST billing. TTL enabled.
- **S3** template bucket (`jigs-templates-{stage}-{account}`) — versioned, private, S3-managed encryption.
- **S3** web bucket (`jigs-web-{stage}-{account}`) — hosts SPA static files.
- **Cognito** User Pool (`jigs-{stage}`) — email signup, Google OAuth (TODO: configure identity provider). Callback URLs differ per stage.
- **Lambda** function (`jigs-api-{stage}`) — ARM64, 512MB, 5min timeout. Function URL with RESPONSE_STREAM invoke mode.
- **CloudFront** distribution — SPA from web bucket (default), API from Lambda Function URL (`/api/*`). SPA fallback: 404/403 → `/index.html`.

## Key Patterns

- **Lambda gets env vars** for TABLE_NAME, TEMPLATE_BUCKET, COGNITO_USER_POOL_ID, COGNITO_CLIENT_ID, STAGE. The API code reads these from `env.ts`.
- **Lambda code** deployed from `../api/dist` — run `pnpm --filter api build` before `cdk deploy`.
- **Prod resources use RETAIN** removal policy. Staging uses DESTROY for easy teardown.
- **Bedrock access** granted via IAM policy (`bedrock:InvokeModel`, `bedrock:InvokeModelWithResponseStream`) on all resources (`*`). Scope down to specific model ARNs in production.

## Deploy

```bash
pnpm --filter api build                  # Bundle API first
cd cdk
cdk synth --context stage=staging        # Validate template
cdk deploy --context stage=staging       # Deploy staging
cdk diff --context stage=prod            # Preview prod changes
cdk deploy --context stage=prod          # Deploy production
```
