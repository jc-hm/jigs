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

CDK commands must run from the `cdk/` directory (that's where `cdk.json` lives, which tells the CDK CLI how to invoke the app). Running `cdk` from the repo root fails with `--app is required`. Use the pnpm scripts so the working directory is correct automatically:

```bash
pnpm --filter api build                                              # Bundle API first (Lambda code comes from ../api/dist)
pnpm --filter web build                                              # Build SPA (web bucket deploy reads from ../web/dist)
pnpm --filter @jigs/cdk deploy:staging                               # Deploy staging (us-west-2)
pnpm --filter @jigs/cdk deploy:staging -- --require-approval never   # Same, non-interactive
pnpm --filter @jigs/cdk diff:staging                                 # Preview staging changes
pnpm --filter @jigs/cdk deploy:prod                                  # Deploy production (eu-central-1)
pnpm --filter @jigs/cdk diff:prod                                    # Preview prod changes
```

If you really need raw `cdk` (e.g. `cdk bootstrap`, `cdk destroy`), `cd cdk` first.
