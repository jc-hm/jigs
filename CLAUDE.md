# Jigs

AI-powered template filling SaaS. First vertical: radiology reports.

> **Product context:** Read `PRODUCT.md` for the product vision, user types, workflows, business model, and guiding principles. Consult it before making product-level decisions or when you need to understand the *why* behind a feature.

## Architecture

- **AWS-native serverless** — Lambda (Function URLs, streaming), DynamoDB, S3, Cognito, Bedrock, CloudFront
- **Two providers only** — AWS + Stripe
- **No report content stored** — avoids PHI liability. Only aggregated usage counters persisted.
- **Skill + S3 model** — DynamoDB stores "skill" records (instructions, tone, taxonomy with S3 pointers). S3 stores template content as individual files per org prefix.

## Stack

| Layer | Tech |
|---|---|
| API | Hono on Lambda Function URL (streaming) |
| Frontend | React + Vite SPA on S3/CloudFront |
| DB | DynamoDB single-table (eu-central-1) |
| Templates | S3 with org-isolated prefixes |
| Auth | Cognito (Google + email/password) |
| AI | Bedrock — Haiku (routing/classification) + Sonnet (filling) |
| IaC | AWS CDK (TypeScript) |
| Payments | Stripe (Meters API, EUR first) |

## AI Flow

Two-step model tiering:
1. **Haiku** classifies intent (NEW_FILL / REFINE / RE_SELECT / UPDATE_TMPL) + matches template from taxonomy (~$0.001)
2. **Sonnet** fills/refines the template with streaming output (~$0.02-0.05)

Session boundaries detected automatically by Haiku. Session state held client-side (no server persistence).

## Key Commands

```bash
docker compose up                    # DynamoDB Local + MinIO
pnpm --filter api run seed           # Seed local DB
pnpm --filter api dev                # API at :3000
pnpm --filter web dev                # Web at :5173 (proxies to :3000)
pnpm -r typecheck                    # Type-check all workspaces
pnpm --filter api build              # Bundle Lambda for deploy
pnpm --filter web build              # Build SPA
cdk deploy --context stage=staging   # Deploy staging
cdk deploy --context stage=prod      # Deploy production
```

## Conventions

- All DynamoDB access goes through `api/src/db/entities.ts` — never use raw SDK calls elsewhere
- S3 template keys always derived from authenticated orgId (from JWT), never from user input
- Usage tracked via atomic counter increments (DynamoDB `ADD`), not per-record writes
- Local dev uses `STAGE=local` env var to switch DynamoDB/S3 endpoints and skip auth
- CDK stages: `staging` and `prod` — completely separate resources per stage

## CLAUDE.md Documentation System

Each major directory has its own `CLAUDE.md` that Claude Code reads automatically when working in that directory:

- `CLAUDE.md` (this file) — project-level architecture and conventions
- `api/CLAUDE.md` — API patterns, how to add routes, entry points
- `web/CLAUDE.md` — frontend patterns, streaming, auth status
- `cdk/CLAUDE.md` — infrastructure resources, deploy workflow

**Keeping them current:** A PostToolUse hook (`.claude/hooks/check-claude-md.sh`) fires after every file edit and reminds the agent to update the nearest CLAUDE.md if the change is architectural. These files should describe *why* and *how*, not *what* — avoid duplicating what's readable from the code itself.
