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

## Template Matching Persona

- Allow users to provide optional direction (in AUTHOR.md or a separate config) about how templates should be matched — e.g., "match by imaging modality and body part" or "match by document type and jurisdiction". This guidance would be passed to the router (Haiku) prompt.

## Fill Page UX

- **Conversational feel**: The Fill page should display a scrollable conversation — user messages and system responses (including errors like "could not match a template") should all appear as chat messages, not just a blank screen with an error toast. The user should be able to scroll through their history.
- **Error messages as responses**: API errors (400, 404, 429, 500) should surface as assistant messages in the conversation, not as separate UI elements. "I couldn't match a template for that — try being more specific about the study type."

## Dev Tooling

- **tsx watch not reloading**: `tsx watch src/local.ts` frequently fails to pick up file changes, requiring manual kill + restart. Investigate why — could be file system event limits, nohup interfering with the watch process, or tsx watch not following transitive imports. Consider alternatives: `nodemon`, `node --watch`, or a wrapper script that restarts on file change.

## Auth

- **Local dev multi-user testing**: Currently local mode hardcodes a single `test-user`. Add support for switching between test personas (e.g., `?user=admin`, `?user=freeuser`) to test role-based behavior without Cognito.
