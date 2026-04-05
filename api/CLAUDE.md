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
- **`src/services/ai/router.ts`** — Haiku intent classification. Returns `{ intent, templateId }`. The router also detects session boundaries (new report vs refinement).
- **`src/services/ai/filler.ts`** — Sonnet streaming fill. Returns an async generator yielding `{ type: "text" }` and `{ type: "usage" }` events.
- **Streaming responses** use Hono's `stream()` helper with SSE format (`data: {json}\n\n`).

## Adding a New Route

1. Create `src/routes/myroute.ts` with `new Hono<AppEnv>()`
2. Register in `src/app.ts` via `app.route("/api/v1/myroute", myRoute)`
3. Auth middleware is applied globally to `/api/*` — no need to add per-route

## Entry Points

- `src/index.ts` — Lambda handler (`handle(app)`)
- `src/local.ts` — Local dev server (port 3000)
- `src/db/seed.ts` — Seeds local DynamoDB with test org, user, and radiology skill
