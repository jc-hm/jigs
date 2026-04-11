# Backlog

Ideas and improvements to address later. Not prioritized — just captured so they don't get lost.

## Next Up — Low-Hanging Fruit

A batch of small, independent, low-ambiguity items that can be bundled into a single focused pass. Each one is a few-minutes-to-an-hour change with no architectural decisions involved; together they cover a handful of small UX papercuts without touching any of the flows currently in motion.

- **$10 starter credit on new org signup**: `autoProvisionUser` creates the `ORG` + `USER` records but does not touch `ORG#{id} / BALANCE`. Add a single `addBalance(orgId, 10)` call so new signups immediately have something to spend. Removes the "balance = 0 → 402 on first request" papercut for new users without wiring Stripe first.
- **Profile page shows remaining balance**: the page currently only shows daily/monthly usage counters. Add a prominent "$X.XX remaining" line read from `ORG#{id} / BALANCE`. The existing `billing/usage` endpoint can return it in one extra field — no new route needed.
- **Auto-scroll chat to bottom in Templates (and Fill if affected)**: when the assistant posts new tool events, the chat column does not scroll. Standard `useEffect` + `ref.scrollIntoView({behavior: "smooth"})` on message-list length change. Audit Fill page for the same behavior.
- **Copy buttons on Fill response**: two buttons, matching the Claude Code pattern — one in the top-right of the filled template block (copies the template text alone), one on hover at the top-left of the assistant bubble (copies the full interaction including user prompt + response). Pure frontend, clipboard API.
- **Steeper retry backoff so users see fewer retry counters**: current `TrackedBedrock` retry sequence shows 4+ "retrying" events before a request lands during throttling. Raise the base delay and multiplier so fewer attempts fit in the same wall-clock window (e.g. `2s → 6s → 18s` instead of `1s → 2s → 4s → 8s → 16s`). Same overall patience, less noisy UI.
- **Agent should not inject `##` headings when not asked**: when creating templates, Claude has been inserting `##` section headings the user did not request. Add a prompt rule: "Match the user's requested structure exactly — do not add markdown headings, bullet lists, or other structural elements the user did not explicitly ask for." One-line prompt addition.

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

## Observability & Debugging

The goal: the user should be able to say "something weird happened in the templates agent a few minutes ago, pull the logs and figure it out" and for that to actually work. Today, CloudWatch has structured logs from the backend but there's no retrieval surface and the frontend doesn't persist anything.

- **Support-mode log retrieval endpoint**: a small `/api/v1/debug/requests?since=...&orgId=...` endpoint (admin-only) that returns recent request records — request id, route, status, duration, agent round count, error messages, the user message preview, and any retries. Backed by a CloudWatch Logs Insights query or (better) a DynamoDB `REQUEST#{id}` item written by the global request middleware. The frontend already gets a `requestId` per agent run — surface it in the UI so the user can cite it.
- **Persist full agent conversation + tool calls per request**: today `log.info("agent.round", ...)` captures tool names and stop reasons but not the raw Claude messages. For debugging prompt-leak and context-loss issues, we need the actual `messages[]` array as seen by Bedrock on each round, retrievable by request id. Write to S3 as NDJSON (one object per round) under `s3://jigs-debug-{stage}/{requestId}.ndjson`, auto-expire after 30 days via lifecycle rule. PHI-safe because no report content — only template editing flows touch this path.
- **Bug: 500 errors in templates agent loop during bulk operations**: seen in practice, not yet diagnosed. Blocked on the retrieval surface above — needs correlated logs before we can hunt.
- **Bug: tool option descriptions leaking in Spanish interactions**: when chatting in Spanish, Claude has emitted the English tool-parameter descriptions from the system prompt verbatim as filler text. The existing rule "never mention tool names" doesn't cover parameter descriptions. Needs a stronger negative rule plus an explicit example in the prompt.
- **Bug: conversation context appears to be lost mid-flow**: reported symptom during multi-turn agent sessions. Unclear whether it's history-threading, prompt-budget truncation, or Claude dropping earlier turns on its own. Needs the persistent per-request log above to diagnose.

## S3 Template Enhancements

- **S3 listing cache**: Cache `ListObjectsV2` results for fill-flow performance at scale. Invalidate on file mutations.
- **S3 versioning**: Enable S3 bucket versioning to show version history in the UI and allow rollback.
- **Agent operation preview/confirm**: Show a diff view before the AI agent applies changes, so users can review before committing.
- **Template catalog file**: A hidden file (e.g., `_catalog.json` above `/templates/`) with `{ path, title, description }` entries for richer routing. Rebuilt when files change. Currently v0 routes by filename only — this would improve routing quality for ambiguous names.

## Templates Agent UX

- **Model `AgentAction` kind explicitly**: The agent currently emits a single flat list of "things touched" (path + tool name). The frontend has to filter by tool name (`tool !== "create_folder"`) to avoid passing folder paths to `selectFile`, which is fragile — any new folder-producing tool silently breaks it. Cleaner: tag each `AgentAction` with `kind: "file" | "folder"` (or split into two arrays at the source) so the frontend can ask for "files only" without enumerating tools. Only worth doing if a second folder-producing tool appears.
- **Graceful Lambda-timeout warning from the backend**: The agent route relies on the frontend's "stream ended without a terminal event" detection to recover from Lambda being killed at 15 min. That's correct as a floor (it also catches network drops, client sleep, etc.), but the backend *could* do better for the specific Lambda-timeout case: poll `getRemainingTimeInMillis()` and emit a proper `error` SSE event at ~14:30 with a message like "hit maximum execution time, some changes may be partial." Gives the user a clearer explanation than the generic "interrupted" message. Additive to the frontend detection, not a replacement.
- **Text selection broken in chat column**: cannot currently highlight and copy text from the Templates chat bubbles. Likely a CSS `user-select: none` inherited from a wrapper, or a parent capturing pointer events. Audit and fix.
- **Stop button during agent runs**: let the user cancel an in-flight agent session (e.g. when Claude is clearly spinning on the wrong path). Wire an `AbortController` through `streamAgent` so the SSE fetch can be cancelled, and ideally notify the server so it bails out of the Bedrock loop. Same pattern needed for the Fill stream.
- **Refresh file tree on any mutation, not just on stream events**: the tree auto-refreshes after agent runs but manual edits in the editor (save, rename, delete via UI buttons) don't always trigger a refresh. Audit mutation paths and ensure each calls `refreshTree()`.
- **Spinners for file load and tree load**: clicking a file in the tree has no immediate visual response until the `cat` call returns. Same when the tree itself is loading. Add an inline spinner / skeleton in each to communicate progress.
- **Template path in URL hash**: `#templates` should become `#templates/path/to/file.md` so reloads land the user on the same file, and the URL updates as the user navigates. Also unlocks the "matched template link" item on the Fill page.
- **Dedicated "create template from pasted text" flow**: users arriving from other tools want to paste an existing template in free-form text and have the agent generate a well-formed file from it. A small modal with a textarea → calls the agent with a canned system prompt. Probably a better onboarding path than "describe the template you want."
- **Page reload resilience for long flows**: if the user reloads while an agent or fill stream is running, the stream is lost and they have to restart from scratch. Options: persist in-flight request state to DynamoDB and replay on reconnect, or background the Lambda work and expose a status endpoint to poll. Both are substantial architectural changes — capture the problem now, decide the approach later.

## Template Matching Persona

- Allow users to provide optional direction (in AUTHOR.md or a separate config) about how templates should be matched — e.g., "match by imaging modality and body part" or "match by document type and jurisdiction". This guidance would be passed to the router (Haiku) prompt.

## Fill Page UX

- **Conversational feel**: The Fill page should display a scrollable conversation — user messages and system responses (including errors like "could not match a template") should all appear as chat messages, not just a blank screen with an error toast. The user should be able to scroll through their history.
- **Error messages as responses**: API errors (400, 404, 429, 500) should surface as assistant messages in the conversation, not as separate UI elements. "I couldn't match a template for that — try being more specific about the study type."
- **Collapsed "matched template" line with link**: the Fill response currently prints the matched template path inline as plain text. Replace with a small collapsed row ("Matched: `neuro/brain-mri.md`") that, when clicked, opens the Templates page at that file via the new URL hash scheme. Depends on the Templates URL hash item.
- **Stop button during fill streams**: same story as the Templates agent stop button — `AbortController` on the fetch, server-side cancel if possible.
- **Graceful throttling UX on Profile page**: when the `billing/usage` endpoint is throttled or errors, the page currently errors out hard. Add a "loading usage..." fallback and retry logic, so a flaky profile fetch doesn't block the user from seeing their balance.

## Layout & Navigation

- **Horizontal tab bar at the top**: Fill / Templates / Profile tabs currently consume sidebar real estate. Move them to a top bar so the sidebar can host content-relevant navigation (file tree on Templates, history on Fill) without fighting for pixels.
- **Resizable main panels**: the Templates page has a fixed three-column layout (chat / editor / tree). Users should be able to drag column dividers to rebalance. `react-resizable-panels` is the standard path.

## Internationalization

- **Spanish UI translation**: the product UI is English-only even though Spanish radiology reports are a core use case and users already interact with the agent in Spanish. Add i18n with simple key-based locale files (`messages.en.json` / `messages.es.json`), detect browser locale on load, offer a manual toggle in Profile. `react-i18next` is the path of least resistance.

## Sharing & Collaboration

- **Invitation-based template sharing**: today templates are strictly scoped to `{userId}/templates/`. Let a user invite another user (by email) to share a template (or a folder of templates). Requires: a sharing model in DynamoDB (share records keyed by inviter + invitee), an invitation flow (email via Cognito or SES), and lookup logic in the S3 file ops so reads check shared prefixes as well as the user's own. Non-trivial; capture for later.

## Dev Tooling

- **tsx watch not reloading**: `tsx watch src/local.ts` frequently fails to pick up file changes, requiring manual kill + restart. Investigate why — could be file system event limits, nohup interfering with the watch process, or tsx watch not following transitive imports. Consider alternatives: `nodemon`, `node --watch`, or a wrapper script that restarts on file change.

## Session & Auth

- **Local dev multi-user testing**: Currently local mode hardcodes a single `test-user`. Add support for switching between test personas (e.g., `?user=admin`, `?user=freeuser`) to test role-based behavior without Cognito.
- **Session timeout behavior**: sessions currently persist across a full day (and longer) with no forced re-auth. Cognito defaults are ID token 1h / refresh 30d, and `amazon-cognito-identity-js` silently refreshes the ID token on each call, so users only re-log in when the refresh token expires a month later. Decide whether that's acceptable (arguably fine for a single-user medical tool), add an explicit short-lived session mode (force re-auth after N hours of inactivity), or at least surface a "your session will expire in X" warning. Start by measuring the actual behavior — what is `getSession()` doing on page load after 24h?

## Usage Tracking & Billing

Phase 1 (wrapped Bedrock client + org balance) is in scope. The following are deferred until needed:

- **S3 per-call event records**: Write each Bedrock call as an NDJSON line to `s3://jigs-usage-{stage}-{account}/events/year=YYYY/month=MM/day=DD/{requestId}.ndjson`. Enables historical graphs, per-template cost analysis, and billing dispute audit trail. Add when "show me my usage by day" or per-call drilldown matters. Hive-style partitioning is forward-compatible with Athena when query needs grow.
- **Athena over S3 events**: SQL analytics on the NDJSON event store. Add when scanning files in Lambda becomes too slow (~100K+ events).
- **Stripe top-up webhook**: Wire Stripe Checkout to `addBalance(orgId, amountUsd)` when ready to monetize. The balance mechanic is already in place — only the payment trigger is missing.
- **Spread/markup pricing**: The `SPREAD` constant in `tracker.ts` starts at `1.0` (cost-only). Set it when pricing is decided. Cost-plus model is data-ready — `costUsd` per call is captured in counters.
- **Per-template / per-model cost analytics**: Needs S3 event records to break down cost by `templatePath` or `modelId`. Counter approach can't decompose totals.
- **Agent rate limiting**: Currently no limit on agent rounds (per direction). Track but don't gate. Add a separate `agentRoundsToday` counter with a free-tier cap if abuse becomes a concern.
- **Replace daily report counter with balance check**: Once topups are live, the free-tier daily limit (`FREE_DAILY_LIMIT = 10` in `tracker.ts`) can be retired in favor of "balance > 0". New users get a starter credit on signup.
- **Multi-month usage history endpoint**: `GET /api/v1/billing/usage/history?months=N` querying `SK begins_with USAGE#`. Already supported by the key design — just needs the route handler and frontend chart.
- **Super-admin credit dashboard**: a protected page listing all orgs with current balance, lifetime topups, lifetime spend, and a "top up" button that calls `addBalance()`. Gated on an `isSuperAdmin` flag on the `USER` record (does not currently exist — add one). Enables manually granting credit to early users without Stripe wired up.
