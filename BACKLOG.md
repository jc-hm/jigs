# Backlog

Ideas and improvements to address later. Not prioritized — just captured so they don't get lost.

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

## S3 Template Enhancements

- **S3 listing cache**: Cache `ListObjectsV2` results for fill-flow performance at scale. Invalidate on file mutations.
- **S3 versioning**: Enable S3 bucket versioning to show version history in the UI and allow rollback.
- **Agent operation preview/confirm**: Show a diff view before the AI agent applies changes, so users can review before committing.
- **Template catalog file**: A hidden file (e.g., `_catalog.json` above `/templates/`) with `{ path, title, description }` entries for richer routing. Rebuilt when files change. Currently v0 routes by filename only — this would improve routing quality for ambiguous names.

## Templates Agent UX

- **Model `AgentAction` kind explicitly**: The agent currently emits a single flat list of "things touched" (path + tool name). The frontend has to filter by tool name (`tool !== "create_folder"`) to avoid passing folder paths to `selectFile`, which is fragile — any new folder-producing tool silently breaks it. Cleaner: tag each `AgentAction` with `kind: "file" | "folder"` (or split into two arrays at the source) so the frontend can ask for "files only" without enumerating tools. Only worth doing if a second folder-producing tool appears.
- **Graceful Lambda-timeout warning from the backend**: The agent route relies on the frontend's "stream ended without a terminal event" detection to recover from Lambda being killed at 15 min. That's correct as a floor (it also catches network drops, client sleep, etc.), but the backend *could* do better for the specific Lambda-timeout case: poll `getRemainingTimeInMillis()` and emit a proper `error` SSE event at ~14:30 with a message like "hit maximum execution time, some changes may be partial." Gives the user a clearer explanation than the generic "interrupted" message. Additive to the frontend detection, not a replacement.

## Template Matching Persona

- Allow users to provide optional direction (in AUTHOR.md or a separate config) about how templates should be matched — e.g., "match by imaging modality and body part" or "match by document type and jurisdiction". This guidance would be passed to the router (Haiku) prompt.

## Fill Page UX

- **Conversational feel**: The Fill page should display a scrollable conversation — user messages and system responses (including errors like "could not match a template") should all appear as chat messages, not just a blank screen with an error toast. The user should be able to scroll through their history.
- **Error messages as responses**: API errors (400, 404, 429, 500) should surface as assistant messages in the conversation, not as separate UI elements. "I couldn't match a template for that — try being more specific about the study type."

## Dev Tooling

- **tsx watch not reloading**: `tsx watch src/local.ts` frequently fails to pick up file changes, requiring manual kill + restart. Investigate why — could be file system event limits, nohup interfering with the watch process, or tsx watch not following transitive imports. Consider alternatives: `nodemon`, `node --watch`, or a wrapper script that restarts on file change.

## Auth

- **Local dev multi-user testing**: Currently local mode hardcodes a single `test-user`. Add support for switching between test personas (e.g., `?user=admin`, `?user=freeuser`) to test role-based behavior without Cognito.

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
