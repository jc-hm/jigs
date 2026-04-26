# Backlog

Ideas and improvements to address later. Not prioritized — just captured so they don't get lost.

## Separate AWS Accounts for Staging/Prod Isolation

Currently staging (us-west-2) and prod (eu-central-1) share the same AWS account. This creates a fundamental isolation gap: CDK bootstrap roles and the CloudFormation execution role for us-east-1 (where both cert stacks live) are account-wide, so staging credentials can transitively affect prod resources through the CFN exec role regardless of IAM policy scoping.

**The fix:** create a separate AWS account for prod (via AWS Organizations or standalone), and redeploy the prod stack there. CDK already supports this natively — `bin/jigs.ts` sets `env: { account, region }` per stage, so it's a matter of pointing `prod.account` at the new account ID and running `cdk bootstrap` there.

**Benefits:**
- Staging credentials are account-scoped — structurally impossible to touch prod
- No IAM policy maintenance as the stack evolves (new services/regions automatically isolated)
- Separate billing, separate CloudWatch, separate resource limits
- IAM Identity Center (SSO) makes managing two accounts low-friction

**Migration steps:**
1. Create a new AWS account (Organization recommended for consolidated billing)
2. Bootstrap CDK in the new account: `cdk bootstrap aws://NEW_ACCOUNT/eu-central-1` and `aws://NEW_ACCOUNT/us-east-1`
3. Update `STAGE_CONFIG.prod.account` in `bin/jigs.ts` to the new account ID
4. Deploy prod stack to the new account (`pnpm deploy:prod`)
5. Migrate live data (DynamoDB export/import, S3 sync)
6. Update DNS and cut over

## Unified Agent Paradigm

The current architecture has two distinct AI surfaces: a narrow intent classifier + filler for the Fill page (4 hard-coded intents: NEW_FILL, REFINE, RE_SELECT, UPDATE_TMPL), and an open tool-use agent for the Templates page. These are separate code paths with separate prompts and separate UIs.

**The idea:** replace both with a single agent that can operate in either context, governed by a restricted tool set and a strong system prompt that keeps it on-task. The Fill context would give the agent access only to "fill this template" and "refine this output" tools. The Templates context would give it file management tools. The key challenge is the constraint — an open agent without guardrails will drift into general assistant territory, which is out of scope for Jigs.

**Why it's worth exploring:**

- The current 4-intent router is brittle. UPDATE_TMPL is classified but returns 501 in the fill route — users asking to edit a template from the fill UI get an error. RE_SELECT and REFINE are semantically distinct but handled by the same filler call, making accurate billing and logging hard.
- Real user utterances don't map cleanly to 4 intents. "Compare with my last report" or "do this in Spanish" fall through the cracks. An agent can reason about intent rather than classify into a fixed enum.
- A unified interface means one streaming protocol, one session model, one retry/heartbeat mechanism — less duplication.

**The constraint challenge is the core design problem:** how do you give the model enough freedom to be useful (multi-turn, tool selection, clarifying questions) while preventing it from becoming a general assistant that ignores templates entirely? Options include:

- A strong system prompt that frames the agent's identity ("you are a template-filling assistant for radiology reports — you have access to these tools and nothing else")
- Tool-level restrictions (the fill context literally does not receive file management tools, and vice versa)
- An output validator that checks whether the final response is a filled template or a file change, and rejects/retries anything else

**Connection to the counting problem:** once intent is determined by the agent itself (rather than a fixed classifier), the agent can emit a structured signal — e.g., a `report_filled` tool call — when it actually produces a report. That signal becomes the definitive counter increment, not a heuristic on action type or route intent.

Worth designing before implementing. The templates agent already exists and proves the tool-use loop works — the question is whether the fill side can be migrated to the same paradigm without sacrificing speed (the 4-intent router is very fast; an agent adds at least one extra round-trip).

## Voice Input UX

- **Silence detection**: Detect when the browser mic returns silence (audio level stuck at 128) and show a warning guiding the user to check their mic settings. Common issue on Chrome/macOS — wrong mic selected, CoreAudio daemon stuck, or OS-level permissions stale.
- **Mic selector**: Let users pick their microphone device in the app instead of relying on browser/OS defaults. Chrome's `chrome://settings/content/microphone` is buried and users won't find it.
- **Visual feedback during recording**: Show an audio waveform or pulsing animation so users can confirm the mic is actually picking up sound, not just "recording" silence.
- **Fallback guidance**: If Web Speech API isn't supported (Firefox, some mobile browsers), show a message explaining why voice isn't available rather than silently hiding the button.

## Dictation Service Integration

- **Replace Web Speech API with a dedicated dictation service**: Chrome's built-in speech recognition performs poorly for Spanish medical terminology on macOS. Candidates:
  - **AssemblyAI** — reportedly cheaper and more accurate than AWS Transcribe. Streaming via WebSocket. Worth evaluating first.
  - **AWS Transcribe Medical** — streaming via WebSocket, ~$0.024/min. AWS-native, but a third provider to manage.
  - Evaluate both for Spanish medical vocabulary accuracy, latency, and cost.
- **Language switching**: Users should be able to dictate in Spanish while the UI remains in English (or vice versa). The current `recognition.lang = "en-US"` is hardcoded.

## CloudWatch Alarms

Two metric filters + alarms to add in CDK — covers the "paged before users complain" layer that Sentry doesn't:

- **Error rate alarm**: metric filter on `level = "error"` in the Lambda log group → CloudWatch metric → alarm if count > N in a 5-minute window → SNS → email. Catches silent server errors that don't surface as user reports.
- **Daily AI cost alarm**: metric filter extracting `cost_usd` from `log.bedrock()` lines → CloudWatch metric → alarm if cumulative daily total crosses a threshold (e.g. $5). Guards against a runaway agent loop or unexpected abuse before the bill lands.

Both are ~20 lines of CDK each. Low effort, no new infrastructure.

## Observability & Debugging

The goal: the user should be able to say "something weird happened in the templates agent a few minutes ago, pull the logs and figure it out" and for that to actually work. Today, CloudWatch has structured logs from the backend but there's no retrieval surface and the frontend doesn't persist anything.

- **Support-mode log retrieval endpoint**: a small `/api/v1/debug/requests?since=...&orgId=...` endpoint (admin-only) that returns recent request records — request id, route, status, duration, agent round count, error messages, the user message preview, and any retries. Backed by a CloudWatch Logs Insights query or (better) a DynamoDB `REQUEST#{id}` item written by the global request middleware. The frontend already gets a `requestId` per agent run — surface it in the UI so the user can cite it.
- **Persist full agent conversation + tool calls per request**: today `log.info("agent.round", ...)` captures tool names and stop reasons but not the raw Claude messages. For debugging prompt-leak and context-loss issues, we need the actual `messages[]` array as seen by Bedrock on each round, retrievable by request id. Write to S3 as NDJSON (one object per round) under `s3://jigs-debug-{stage}/{requestId}.ndjson`, auto-expire after 30 days via lifecycle rule. PHI-safe because no report content — only template editing flows touch this path.
- **Bug: 500 errors in templates agent loop during bulk operations**: seen in practice, not yet diagnosed. Blocked on the retrieval surface above — needs correlated logs before we can hunt.
- **Bug: conversation context appears to be lost mid-flow**: reported symptom during multi-turn agent sessions. Unclear whether it's history-threading, prompt-budget truncation, or Claude dropping earlier turns on its own. Needs the persistent per-request log above to diagnose.

## S3 Template Enhancements

- **S3 listing cache**: Cache `ListObjectsV2` results for fill-flow performance at scale. Invalidate on file mutations.
- **S3 versioning**: Enable S3 bucket versioning to show version history in the UI and allow rollback.
- **Agent operation preview/confirm**: Show a diff view before the AI agent applies changes, so users can review before committing.
- **Template catalog file**: A hidden file (e.g., `_catalog.json` above `/templates/`) with `{ path, title, description }` entries for richer routing. Rebuilt when files change. Currently v0 routes by filename only — this would improve routing quality for ambiguous names.

## Templates Agent UX

- **Model `AgentAction` kind explicitly**: The agent currently emits a single flat list of "things touched" (path + tool name). The frontend has to filter by tool name (`tool !== "create_folder"`) to avoid passing folder paths to `selectFile`, which is fragile — any new folder-producing tool silently breaks it. Cleaner: tag each `AgentAction` with `kind: "file" | "folder"` (or split into two arrays at the source) so the frontend can ask for "files only" without enumerating tools. Only worth doing if a second folder-producing tool appears.
- **Graceful Lambda-timeout warning from the backend**: The agent route relies on the frontend's "stream ended without a terminal event" detection to recover from Lambda being killed at 15 min. That's correct as a floor (it also catches network drops, client sleep, etc.), but the backend *could* do better for the specific Lambda-timeout case: poll `getRemainingTimeInMillis()` and emit a proper `error` SSE event at ~14:30 with a message like "hit maximum execution time, some changes may be partial." Gives the user a clearer explanation than the generic "interrupted" message. Additive to the frontend detection, not a replacement.
- **Stop button during agent runs**: let the user cancel an in-flight agent session (e.g. when Claude is clearly spinning on the wrong path). Wire an `AbortController` through `streamAgent` so the SSE fetch can be cancelled, and ideally notify the server so it bails out of the Bedrock loop. Same pattern needed for the Fill stream.
- **Refresh file tree on any mutation, not just on stream events**: the tree auto-refreshes after agent runs but manual edits in the editor (save, rename, delete via UI buttons) don't always trigger a refresh. Audit mutation paths and ensure each calls `refreshTree()`.
- **Dedicated "create template from pasted text" flow**: users arriving from other tools want to paste an existing template in free-form text and have the agent generate a well-formed file from it. A small modal with a textarea → calls the agent with a canned system prompt. Probably a better onboarding path than "describe the template you want."
- **Page reload resilience for long flows**: if the user reloads while an agent or fill stream is running, the stream is lost and they have to restart from scratch. Options: persist in-flight request state to DynamoDB and replay on reconnect, or background the Lambda work and expose a status endpoint to poll. Both are substantial architectural changes — capture the problem now, decide the approach later.

## Template Matching Persona

- Allow users to provide optional direction (in AUTHOR.md or a separate config) about how templates should be matched — e.g., "match by imaging modality and body part" or "match by document type and jurisdiction". This guidance would be passed to the router (Haiku) prompt.

## Fill Page UX

- **Conversational feel**: The Fill page should display a scrollable conversation — user messages and system responses (including errors like "could not match a template") should all appear as chat messages, not just a blank screen with an error toast. The user should be able to scroll through their history.
- **Error messages as responses**: API errors (400, 404, 429, 500) should surface as assistant messages in the conversation, not as separate UI elements. "I couldn't match a template for that — try being more specific about the study type."
- **Stop button during fill streams**: same story as the Templates agent stop button — `AbortController` on the fetch, server-side cancel if possible.

## Layout & Navigation

- **Horizontal tab bar at the top**: Fill / Templates / Profile tabs currently consume sidebar real estate. Move them to a top bar so the sidebar can host content-relevant navigation (file tree on Templates, history on Fill) without fighting for pixels.
- **Resizable main panels**: the Templates page has a fixed three-column layout (chat / editor / tree). Users should be able to drag column dividers to rebalance. `react-resizable-panels` is the standard path.

## Internationalization

- **Spanish UI translation**: the product UI is English-only even though Spanish radiology reports are a core use case and users already interact with the agent in Spanish. Add i18n with simple key-based locale files (`messages.en.json` / `messages.es.json`), detect browser locale on load, offer a manual toggle in Profile. `react-i18next` is the path of least resistance.

## Sharing & Collaboration

Invite-based onboarding (copy inviter's templates on signup) is implemented — see `docs/signup-flow.md`. Remaining items:

- **Invite referral tracking & rewards**: Track which invite codes led to signups (add `claimedBy: userId` and atomic `claimedCount` to `INVITE#` records). Surface in Profile: "your link has been used N times". Foundation for a credit-top-up reward when an invite is claimed — design the reward mechanic before implementing disbursement.
- **Invite analytics**: track how many users each invite code has been claimed by. Add `claimedCount` (atomic increment) to the `INVITE#` record. Surface in Profile ("your link has been used N times").
- **Pre-signup Cognito gate**: currently the signup form is hidden by URL param only (client-side). For stronger access control, add a Cognito Pre-Signup Lambda trigger that rejects signups without a valid `custom:invite_code` (unless an admin bypass attribute is set). Hardening step for when the pilot becomes closed beta.
- **Multi-user orgs**: today each user gets their own org. Invite into a shared org (same template namespace, shared balance). Requires: org membership model in DynamoDB, shared S3 prefix (`{orgId}/templates/` instead of `{userId}/templates/`), role-based access (admin can manage templates, users fill only). Significant architectural change.
- **Live template sync**: currently invited users get a snapshot at signup. If the inviter updates templates later, invitees don't see the changes. Shared-org model (above) solves this; alternatively, a "sync from inviter" button could re-run the copy on demand.

## Feedback & Contact

The feedback system is implemented (`FEEDBACK#` entity, `POST /api/v1/feedback` + `POST /api/public/v1/feedback`, admin Feedback tab). Remaining items:

- **Thumbs up/down reactions on fill interactions**: Add 👍/👎 buttons to each AI response in the Fill page. Call `POST /api/v1/feedback` with `type: "reaction"`, `rating: "up"|"down"`, and `context: { requestId, action: "fill" }`. Design the reaction UI placement first (inline with copy button? below streamed output?).
- **GDPR logging cleanup**: `tracked-bedrock.ts` logs `inputPreview` (800 chars) and `outputPreview` (800 chars) of Bedrock content to CloudWatch in prod. `agent.ts` logs `messagePreview` (200 chars). Strip these in prod by gating on `process.env.STAGE !== "prod"`. Staging keeps previews for debugging. Satisfies GDPR Art. 5(1)(c) data minimization.

## Dev Tooling

- **tsx watch not reloading**: `tsx watch src/local.ts` frequently fails to pick up file changes, requiring manual kill + restart. Investigate why — could be file system event limits, nohup interfering with the watch process, or tsx watch not following transitive imports. Consider alternatives: `nodemon`, `node --watch`, or a wrapper script that restarts on file change.

## Session & Auth

- **Cognito token expiration tuning**: ID token default TTL is 1 hour, refresh token is 30 days. With the `loggedOutAt` DynamoDB revocation in place, force-logout takes effect immediately for API calls, but the 1h ID token window is still "live" from the client's perspective (it just fails on next use). Consider shortening the ID token TTL to 5–15 min in the Cognito User Pool client — the tradeoff is more frequent refreshes vs. smaller revocation window. Measure real-world refresh cadence first.
- **Local dev multi-user testing**: Currently local mode hardcodes a single `test-user`. Add support for switching between test personas (e.g., `?user=admin`, `?user=freeuser`) to test role-based behavior without Cognito.
- **Session timeout behavior**: sessions currently persist across a full day (and longer) with no forced re-auth. Cognito defaults are ID token 1h / refresh 30d, and `amazon-cognito-identity-js` silently refreshes the ID token on each call, so users only re-log in when the refresh token expires a month later. Decide whether that's acceptable (arguably fine for a single-user medical tool), add an explicit short-lived session mode (force re-auth after N hours of inactivity), or at least surface a "your session will expire in X" warning. Start by measuring the actual behavior — what is `getSession()` doing on page load after 24h?

## Usage Tracking & Billing

Phase 1 (wrapped Bedrock client + org balance) is in scope. The following are deferred until needed:

- **S3 per-call event records**: Write each Bedrock call as an NDJSON line to `s3://jigs-usage-{stage}-{account}/events/year=YYYY/month=MM/day=DD/{requestId}.ndjson`. Enables historical graphs, per-template cost analysis, and billing dispute audit trail. Add when "show me my usage by day" or per-call drilldown matters. Hive-style partitioning is forward-compatible with Athena when query needs grow.
- **Athena over S3 events**: SQL analytics on the NDJSON event store. Add when scanning files in Lambda becomes too slow (~100K+ events).
- **Explicit prompt caching on Bedrock**: Add `cachePoint` markers to Bedrock calls to reduce cost on repeated prefixes. Bedrock has no implicit/automatic caching (unlike Anthropic's direct API), so every call pays full price today. Two strong candidates: (1) filler — cache after system prompt + template body, so each `REFINE` turn pays ~10% instead of 100% on that prefix; (2) agent — cache after system prompt + tool definitions, which are identical across all 25 rounds of the loop. Cache write costs 1.25x but reads cost 0.10x — breaks even on the first re-use. Minimum cacheable size is 2,048 tokens for Sonnet, 1,024 for Haiku. Note: the conversation history itself can't be cached (it changes each turn); only the stable prefix before it benefits.
- **Stripe top-up webhook**: Wire Stripe Checkout to `addBalance(orgId, amountUsd)` when ready to monetize. The balance mechanic is already in place — only the payment trigger is missing.
- **Spread/markup pricing**: The `SPREAD` constant in `tracker.ts` starts at `1.0` (cost-only). Set it when pricing is decided. Cost-plus model is data-ready — `costUsd` per call is captured in counters.
- **Per-template / per-model cost analytics**: Needs S3 event records to break down cost by `templatePath` or `modelId`. Counter approach can't decompose totals.
- **Agent rate limiting**: Currently no limit on agent rounds (per direction). Track but don't gate. Add a separate `agentRoundsToday` counter with a free-tier cap if abuse becomes a concern.
- **Replace daily report counter with balance check**: Once topups are live, the free-tier daily limit (`FREE_DAILY_LIMIT = 10` in `tracker.ts`) can be retired in favor of "balance > 0". New users get a starter credit on signup.
- **Multi-month usage history endpoint**: `GET /api/v1/billing/usage/history?months=N` querying `SK begins_with USAGE#`. Already supported by the key design — just needs the route handler and frontend chart.
- **Super-admin credit dashboard**: a protected page listing all orgs with current balance, lifetime topups, lifetime spend, and a "top up" button that calls `addBalance()`. Gated on an `isSuperAdmin` flag on the `USER` record (does not currently exist — add one). Enables manually granting credit to early users without Stripe wired up.
