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

## Auth

- **Local dev multi-user testing**: Currently local mode hardcodes a single `test-user`. Add support for switching between test personas (e.g., `?user=admin`, `?user=freeuser`) to test role-based behavior without Cognito.
