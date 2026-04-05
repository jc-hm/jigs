# Web — React + Vite SPA

Single-page app served from S3 via CloudFront. Communicates with the API via fetch/SSE.

## Architecture Decisions

- **Vite** — replaced webpack/CRA. Instant dev server, <100ms HMR. Build tool, not a framework.
- **Tailwind CSS v4** — utility classes in JSX, no separate CSS files. Configured via `@tailwindcss/vite` plugin.
- **No router library yet** — simple state-based page switching in `App.tsx`. Add `react-router` when URL routing matters.
- **API proxy in dev** — Vite proxies `/api` to `localhost:3000` (Hono dev server). In production, CloudFront routes `/api/*` to the Lambda Function URL.

## Key Patterns

- **Streaming** — `src/lib/api.ts` exports `streamFill()` async generator. Reads SSE events from the fill endpoint. Components consume it with `for await`.
- **Voice input** — `src/components/VoiceInput.tsx` uses browser-native Web Speech API. Zero backend cost. Falls back to hidden if browser doesn't support it.
- **Session state is client-side** — conversation history (`messages` array) is held in React state and sent with each request. No server-side session persistence.

## Pages

- **Fill** (`pages/Fill.tsx`) — Primary UI. Chat-style input with mic button, streaming output. 90% of user time spent here.
- **Templates** (`pages/Templates.tsx`) — Placeholder. Will be template management with tree editor.
- **Profile** (`pages/Profile.tsx`) — Shows usage counters (daily/monthly) from `/api/v1/billing/usage`.

## Auth (TODO)

Cognito integration not yet wired in the frontend. Currently relies on local dev mode (API skips auth). Next step: add Cognito SDK (`amazon-cognito-identity-js` or `@aws-amplify/auth`) for login/signup flow with Google + email/password.
