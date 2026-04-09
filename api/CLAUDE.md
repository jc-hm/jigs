# API — Hono on Lambda

Hono API serving streaming (fill), file management (templates), agent, and billing endpoints via a single Lambda Function URL.

## Architecture Decisions

- **Single Lambda, single Hono app** — no API Gateway. Lambda Function URLs provide streaming support with 15min timeout.
- **Hono chosen over Express/Fastify** — native Lambda streaming via `streamHandle()`, Web Standards APIs (portable to other runtimes), smallest cold start footprint.
- **Auth is application-level** — Cognito JWT validated in middleware using `aws-jwt-verify` (JWKS cached in memory, ~1ms after first call). No API Gateway authorizer.
- **Local dev runs as plain Node.js** — `src/local.ts` uses `@hono/node-server`. Same app code, no Lambda emulator needed.

## Key Patterns

- **`src/types.ts`** — defines `AppEnv` with typed context variables. All route files must use `new Hono<AppEnv>()` to get typed `c.get("user")`.
- **`src/middleware/auth.ts`** — in local mode (`STAGE=local`), returns a hardcoded test user. In deployed mode, validates Cognito ID token (`tokenUse: "id"`) using `aws-jwt-verify` (JWKS cached). On first sign-in, auto-provisions a new Org + User in DynamoDB via `autoProvisionUser()`. The `/api/config` endpoint is public (before auth middleware) and returns Cognito pool/client IDs for the frontend. In local mode it returns `{ auth: null }` — this is the only signal the frontend uses to skip auth.
- **Lambda ESM** — esbuild outputs `.mjs` extension so Lambda treats the bundle as ESM. This is required because `aws-jwt-verify` uses `import` for Node builtins (`crypto`, `https`). The CDK handler is `index.handler` which resolves to `index.mjs`.
- **`src/db/entities.ts`** — ALL DynamoDB operations live here. Never use raw SDK calls in routes or services.
- **AI provider pattern** — `src/services/ai/provider.ts` returns `AIRouter`, `AIFiller`, and `AIAgent` implementations based on `AI_PROVIDER` env var:
  - `mock` (default local) — deterministic canned responses from `mock.ts`
  - `ollama` — local Ollama for interactive dev (`pnpm dev:ollama`). Implementation in `ollama.ts`.
  - `bedrock` — real AWS Bedrock (always used in deployed mode). Router in `router.ts`, filler in `filler.ts`, agent in `agent.ts`.
  Routes use `getAIRouter()`, `getAIFiller()`, and `getAIAgent()`, never import implementations directly.
- **`src/services/ai/types.ts`** — defines `AIRouter`, `AIFiller`, and `AIAgent` interfaces, `Intent`, `FillChunk`, `FillResult` types.
- **`src/services/ai/router.ts`** — Haiku intent classification. Takes `filenames: string[]` (not taxonomy). Exports `buildRouterPrompt()` for unit testing.
- **`src/services/ai/filler.ts`** — Sonnet streaming fill. Takes `(authorInstructions, templateContent, userDescription, conversationHistory?)`.
- **`src/services/ai/agent.ts`** — Sonnet multi-turn tool-use agent for file operations. Max 10 rounds. Tools: read_file, write_file, delete_file, move_file, list_files.
- **`src/services/ai/mock.ts`** — Deterministic mock implementations for testing. Mock filler streams a canned report in chunks.
- **File operations** — `src/services/files/operations.ts` provides S3 file operations (`ls`, `lsRecursive`, `cat`, `write`, `rm`, `mv`, `mkdir`, `findAuthor`) scoped to `{userId}/templates/` prefix. Used by both routes and the AI agent.
- **Streaming responses** use Hono's `stream()` helper with SSE format (`data: {json}\n\n`).

## Adding a New Route

1. Create `src/routes/myroute.ts` with `new Hono<AppEnv>()`
2. Register in `src/app.ts` via `app.route("/api/v1/myroute", myRoute)`
3. Auth middleware is applied globally to `/api/*` — no need to add per-route

## Entry Points

- `src/index.ts` — Lambda handler (`handle(app)`)
- `src/local.ts` — Local dev server (port 3000)
- `src/db/seed.ts` — Seeds local DynamoDB + MinIO with test org, user, template files, and AUTHOR.md. Exports `seed()` for programmatic use in tests.

## Testing

Four tiers, all using vitest:

- **Unit** (`pnpm test`) — Pure logic in `src/**/*.test.ts`. No Docker, no network.
- **Integration** (`pnpm test:integration`) — Full API flows in `src/**/*.integration.test.ts`. Requires Docker (DynamoDB Local + MinIO). AI mocked via provider.
- **Staging smoke** (`pnpm test:staging`) — Real requests to deployed stack in `test/smoke/`. Set `TARGET_URL` and `AUTH_TOKEN` env vars.
- **Prod smoke** (`pnpm test:prod`) — Same suite against prod. Set `TARGET_URL` and `AUTH_TOKEN`.

Test naming: `*.test.ts` = unit, `*.integration.test.ts` = integration. Smoke tests live in `test/smoke/`.
