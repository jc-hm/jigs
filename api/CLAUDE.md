# API — Hono on Lambda

Hono API serving both streaming (fill) and CRUD (skills, templates, billing) endpoints via a single Lambda Function URL.

## Architecture Decisions

- **Single Lambda, single Hono app** — no API Gateway. Lambda Function URLs provide streaming support with 15min timeout.
- **Hono chosen over Express/Fastify** — native Lambda streaming via `streamHandle()`, Web Standards APIs (portable to other runtimes), smallest cold start footprint.
- **Auth is application-level** — Cognito JWT validated in middleware using `aws-jwt-verify` (JWKS cached in memory, ~1ms after first call). No API Gateway authorizer.
- **Local dev runs as plain Node.js** — `src/local.ts` uses `@hono/node-server`. Same app code, no Lambda emulator needed.

## Key Patterns

- **`src/types.ts`** — defines `AppEnv` with typed context variables. All route files must use `new Hono<AppEnv>()` to get typed `c.get("user")`.
- **`src/middleware/auth.ts`** — in local mode (`STAGE=local`), returns a hardcoded test user. In deployed mode, validates Cognito JWT and looks up user from DynamoDB.
- **`src/db/entities.ts`** — ALL DynamoDB operations live here. Never use raw SDK calls in routes or services.
- **AI provider pattern** — `src/services/ai/provider.ts` returns `AIRouter` and `AIFiller` implementations based on `AI_PROVIDER` env var:
  - `mock` (default local) — deterministic canned responses from `mock.ts`
  - `ollama` — local Ollama for interactive dev (`pnpm dev:ollama`). Implementation in `ollama.ts`.
  - `bedrock` — real AWS Bedrock (always used in deployed mode). Implementation in `router.ts` + `filler.ts`.
  Routes use `getAIRouter()` and `getAIFiller()`, never import implementations directly.
- **`src/services/ai/types.ts`** — defines `AIRouter` and `AIFiller` interfaces, `Intent`, `FillChunk`, `FillResult` types.
- **`src/services/ai/router.ts`** — Haiku intent classification (implements `AIRouter`). Also exports `buildRouterPrompt()` as a pure function for unit testing.
- **`src/services/ai/filler.ts`** — Sonnet streaming fill (implements `AIFiller`). Returns an async generator yielding `{ type: "text" }` and `{ type: "usage" }` events.
- **`src/services/ai/mock.ts`** — Deterministic mock implementations for testing. Mock filler streams a canned report in chunks.
- **Streaming responses** use Hono's `stream()` helper with SSE format (`data: {json}\n\n`).

## Adding a New Route

1. Create `src/routes/myroute.ts` with `new Hono<AppEnv>()`
2. Register in `src/app.ts` via `app.route("/api/v1/myroute", myRoute)`
3. Auth middleware is applied globally to `/api/*` — no need to add per-route

## Entry Points

- `src/index.ts` — Lambda handler (`handle(app)`)
- `src/local.ts` — Local dev server (port 3000)
- `src/db/seed.ts` — Seeds local DynamoDB + MinIO with test org, user, radiology skill, and template files. Exports `seed()` for programmatic use in tests.

## Testing

Four tiers, all using vitest:

- **Unit** (`pnpm test`) — Pure logic in `src/**/*.test.ts`. No Docker, no network.
- **Integration** (`pnpm test:integration`) — Full API flows in `src/**/*.integration.test.ts`. Requires Docker (DynamoDB Local + MinIO). AI mocked via provider.
- **Staging smoke** (`pnpm test:staging`) — Real requests to deployed stack in `test/smoke/`. Set `TARGET_URL` and `AUTH_TOKEN` env vars.
- **Prod smoke** (`pnpm test:prod`) — Same suite against prod. Set `TARGET_URL` and `AUTH_TOKEN`.

Test naming: `*.test.ts` = unit, `*.integration.test.ts` = integration. Smoke tests live in `test/smoke/`.
