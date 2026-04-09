# Web — React + Vite SPA

Single-page app served from S3 via CloudFront. Communicates with the API via fetch/SSE.

## Architecture Decisions

- **Vite** — replaced webpack/CRA. Instant dev server, <100ms HMR. Build tool, not a framework.
- **Tailwind CSS v4** — utility classes in JSX, no separate CSS files. Configured via `@tailwindcss/vite` plugin.
- **No router library yet** — simple state-based page switching in `App.tsx`. Add `react-router` when URL routing matters.
- **API proxy in dev** — Vite proxies `/api` to `localhost:3000` (Hono dev server). In production, CloudFront routes `/api/*` to the Lambda Function URL.

## Key Patterns

- **Streaming** — `src/lib/api.ts` exports `streamFill()` async generator. Reads SSE events from the fill endpoint. Components consume it with `for await`.
- **File operations** — `src/lib/api.ts` exports `fileLs()`, `fileCat()`, `fileWrite()`, `fileRm()`, `fileMv()`, `fileMkdir()`, `runAgent()` for template file management.
- **Voice input** — `src/components/VoiceInput.tsx` uses browser-native Web Speech API. Zero backend cost. Falls back to hidden if browser doesn't support it.
- **Session state is client-side** — conversation history (`messages` array) is held in React state and sent with each request. No server-side session persistence.

## Pages

- **Fill** (`pages/Fill.tsx`) — Primary UI. Chat-style input with mic button, streaming output. 90% of user time spent here.
- **Templates** (`pages/Templates.tsx`) — IDE-like layout: AI agent chat (left), text editor (center), file tree (right). Supports CRUD on template files and AI-driven file operations.
- **Profile** (`pages/Profile.tsx`) — Shows usage counters (daily/monthly) from `/api/v1/billing/usage`.

## Auth

- **`src/lib/auth.ts`** — Cognito email/password authentication using `amazon-cognito-identity-js` (SRP protocol). Exports `signUp`, `confirmSignUp`, `resendCode`, `signIn`, `signOut`, `getIdToken`, `hasStoredTokens`.
- **`amazon-cognito-identity-js` requires `global` polyfill** — the library predates ESM and references Node.js `global`. Fixed with `define: { global: "globalThis" }` in `vite.config.ts`. This is the standard workaround for Vite + this library.
- **Token management** — `amazon-cognito-identity-js` handles token storage in localStorage and automatic refresh. `getIdToken()` returns a valid ID token or null.
- **`src/lib/api.ts`** — all API calls attach `Authorization: Bearer {idToken}` header via `authHeaders()`.
- **Auth flow in `App.tsx`** — sign in, sign up, email verification code, auto sign-in after verification. Hash-based routing (`#fill`, `#templates`, `#profile`) preserved across auth state changes.

### Auth config and fail-closed design

`loadAuthConfig()` fetches `GET /api/config` and returns one of three explicit states:
- **`local`** — API explicitly returned `{ auth: null }`. Only the local dev server does this (`STAGE=local`). Auth is skipped.
- **`configured`** — API returned a valid Cognito config. Normal auth flow applies.
- **`error`** — fetch failed (network error, server error, bad JSON). The app shows an error screen with a retry button. **It does NOT fall through to unauthenticated or local mode.** This is critical: a broken API must never grant access.

This fail-closed pattern exists because an earlier bug allowed auth bypass when the Lambda was broken (returning error HTML instead of JSON), which the frontend misinterpreted as "no auth configured" → local mode → auto-authenticated.
