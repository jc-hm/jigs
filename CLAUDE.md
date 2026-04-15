# Jigs

AI-powered template filling SaaS. First vertical: radiology reports.

> **Product context:** Read `docs/PRODUCT.md` for the product vision, user types, workflows, business model, and guiding principles. Consult it before making product-level decisions or when you need to understand the *why* behind a feature. `docs/BACKLOG.md` has captured future ideas. `docs/signup-flow.md` documents the full auth + invite onboarding flow.

## Architecture

- **AWS-native serverless** — Lambda (Function URLs, streaming), DynamoDB, S3, Cognito, Bedrock, CloudFront
- **Two providers only** — AWS + Stripe
- **No report content stored** — avoids PHI liability. Only aggregated usage counters persisted.
- **S3-as-filesystem** — Templates are plain text files in S3 keyed by userId. `AUTHOR.md` files in the folder hierarchy provide fill instructions. DynamoDB stores only org/user/usage records.

## Stack

| Layer | Tech |
|---|---|
| API | Hono on Lambda Function URL (streaming) |
| Frontend | React + Vite SPA on S3/CloudFront |
| DB | DynamoDB single-table (staging: us-west-2, prod: eu-central-1) |
| Templates | S3 with userId-isolated prefixes (`{userId}/templates/`) |
| Auth | Cognito (Google + email/password) |
| AI | Bedrock — Haiku (routing/classification) + Sonnet (filling) |
| IaC | AWS CDK (TypeScript) |
| Payments | Stripe (Meters API, EUR first) |

## AI Flow

Two-step model tiering:
1. **Haiku** classifies intent (NEW_FILL / REFINE / RE_SELECT / UPDATE_TMPL) + matches template by filename (~$0.001)
2. **Sonnet** fills/refines the template with streaming output (~$0.02-0.05)
3. **Sonnet (agent)** — multi-turn tool-use loop for managing template files (create/edit/move/delete)

Session boundaries detected automatically by Haiku. Session state held client-side (no server persistence).

## Key Commands

```bash
docker compose up                    # DynamoDB Local + MinIO
pnpm --filter api run seed           # Seed local DB
pnpm --filter api dev                # API at :3000 (mock AI)
pnpm --filter api dev:ollama         # API at :3000 (local Ollama AI)
pnpm --filter web dev                # Web at :5173 (proxies to :3000)
pnpm -r typecheck                    # Type-check all workspaces
pnpm test                            # Unit tests (no Docker)
pnpm test:integration                # Integration tests (needs Docker)
pnpm test:staging                    # Smoke tests against staging (needs TARGET_URL, AUTH_TOKEN)
pnpm test:prod                       # Smoke tests against prod
pnpm deploy:staging                  # Build api+web then deploy staging (us-west-2)
pnpm deploy:prod                     # Build api+web then deploy production (eu-central-1)
```

## Conventions

- All DynamoDB access goes through `api/src/db/entities.ts` — never use raw SDK calls elsewhere
- S3 template keys always derived from authenticated userId (from JWT), never from user input. All file operations scoped via `{userId}/templates/` prefix.
- Usage tracked via atomic counter increments (DynamoDB `ADD`), not per-record writes
- Local dev uses `STAGE=local` env var to switch DynamoDB/S3 endpoints and skip auth
- CDK stages: `staging` (us-west-2) and `prod` (eu-central-1) — completely separate resources per stage
- AI services accessed via provider pattern (`api/src/services/ai/provider.ts`):
  - `AI_PROVIDER=mock` (default local) — canned responses, for tests and basic frontend work
  - `AI_PROVIDER=ollama` — local Ollama (install: `brew install ollama`, pull: `ollama pull llama3.1:8b`)
  - `AI_PROVIDER=bedrock` — real AWS Bedrock (local needs AWS credentials, deployed mode always uses this)

## CLAUDE.md Documentation System

Each major directory has its own `CLAUDE.md` that Claude Code reads automatically when working in that directory:

- `CLAUDE.md` (this file) — project-level architecture and conventions
- `api/CLAUDE.md` — API patterns, how to add routes, entry points
- `web/CLAUDE.md` — frontend patterns, streaming, auth status
- `cdk/CLAUDE.md` — infrastructure resources, deploy workflow

**Keeping them current:** A PostToolUse hook (`.claude/hooks/check-claude-md.sh`) fires after every file edit and reminds the agent to update the nearest CLAUDE.md if the change is architectural. These files should describe *why* and *how*, not *what* — avoid duplicating what's readable from the code itself.
