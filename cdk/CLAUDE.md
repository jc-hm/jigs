# CDK — AWS Infrastructure

AWS CDK (TypeScript) managing all cloud resources. Single stack deployed per stage.

## Architecture Decisions

- **CDK over Terraform/SST** — TypeScript (same as app), AWS-native, no YAML/HCL. First-party AWS support.
- **Single stack** — `JigsStack` contains all resources. Split into multiple stacks only when deploy times become an issue.
- **Stage-based isolation** — `--context stage=staging|prod` creates completely separate resources. Resource names include the stage suffix.
- **Region per stage** — staging deploys to `us-west-2` (Oregon, near dev in Seattle), prod deploys to `eu-central-1` (Frankfurt, near first market Spain). Region mapped from stage name in `bin/jigs.ts`.

## Stacks

### `Jigs-{stage}` (JigsStack)
Stage-scoped application resources. Deployed per stage (`staging` → us-west-2, `prod` → eu-central-1):
- **DynamoDB** table (`jigs-{stage}`) — single-table design with GSI1 for Cognito ID lookup. PAY_PER_REQUEST billing. TTL enabled.
- **S3** template bucket (`jigs-templates-{stage}-{account}`) — versioned, private, S3-managed encryption.
- **S3** web bucket (`jigs-web-{stage}-{account}`) — hosts SPA static files.
- **Cognito** User Pool (`jigs-{stage}`) — email signup, Google OAuth (TODO: configure identity provider). Callback URLs differ per stage.
- **Lambda** function (`jigs-api-{stage}`) — ARM64, 512MB, 5min timeout. Function URL with RESPONSE_STREAM invoke mode.
- **CloudFront** distribution — SPA from web bucket (default), API from Lambda Function URL (`/api/*`). SPA fallback: 404/403 → `/index.html`.

### `Jigs-email` (EmailStack)
Stage-independent, always deployed to `us-east-1` (SES email receiving constraint). Handles both `ayuda@rellena.me` (prod) and `ayuda@staging.rellena.me` (staging):
- **SES domain identities** for `rellena.me` and `staging.rellena.me` — DKIM records auto-wired into Route53.
- **Route53 DNS records** — MX (SES inbound endpoint), SPF TXT, DMARC TXT, DKIM CNAMEs for both domains.
- **S3** bucket (`jigs-inbound-email-{account}`) — stores raw received email for 7 days.
- **Lambda** forwarder (`cdk/lambda/email-forwarder/index.ts`) — rewrites `From`/`To` headers and forwards via SES to the configured Gmail address, preserving original sender in `Reply-To`.
- **SES receipt rule set** `jigs-inbound` (active) — two rules matching `ayuda@rellena.me` and `ayuda@staging.rellena.me`.
- **IAM user** `jigs-smtp-ayuda` — use with SES SMTP for Gmail "Send as ayuda@rellena.me".

Deploy:
```bash
pnpm --filter @jigs/cdk run -- cdk deploy Jigs-email --require-approval never
```

After deploy, follow `GmailSendAsSetup` output to wire up Gmail reply-as.

## Key Patterns

- **Lambda gets env vars** for TABLE_NAME, TEMPLATE_BUCKET, COGNITO_USER_POOL_ID, COGNITO_CLIENT_ID, STAGE. The API code reads these from `env.ts`.
- **Lambda code** deployed from `../api/dist` — run `pnpm --filter api build` before `cdk deploy`.
- **Prod resources use RETAIN** removal policy. Staging uses DESTROY for easy teardown.
- **Bedrock access** granted via IAM policy (`bedrock:InvokeModel`, `bedrock:InvokeModelWithResponseStream`) on all resources (`*`). Scope down to specific model ARNs in production.

## Deploy

Use the root-level scripts — they build api and web automatically before deploying:

```bash
pnpm deploy:staging   # Build api+web, then cdk deploy staging (us-west-2)
pnpm deploy:prod      # Build api+web, then cdk deploy prod (eu-central-1)
```

`BucketDeployment` in the stack handles the S3 sync and CloudFront invalidation as part of `cdk deploy` — no manual `aws s3 sync` needed.

For CDK-only operations (diff, bootstrap, destroy), use the filter scripts:

```bash
pnpm --filter @jigs/cdk diff:staging   # Preview staging changes (no build)
pnpm --filter @jigs/cdk diff:prod      # Preview prod changes (no build)
```

If you need raw `cdk` (e.g. `cdk bootstrap`, `cdk destroy`), `cd cdk` first.
