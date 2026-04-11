import type { SSEStreamingApi } from "hono/streaming";

/**
 * Write a single SSE event to the Hono `streamSSE` writer.
 *
 * Both streaming endpoints (fill, agent) go through here so the wire
 * format stays consistent: one JSON-encoded event per `data:` field,
 * framed by Hono's `writeSSE` (which handles the trailing `\n\n` and
 * sets `Content-Type: text/event-stream` on the response). The client
 * counterpart is `web/src/lib/api.ts#readSSE`.
 *
 * Passing `streamSSE.writeSSE` its own `{data: string}` object is what
 * gets us the proper headers and keeps CloudFront / browsers from
 * buffering or mis-decoding the stream — which was the failure mode
 * before we adopted the helper.
 */
export async function writeEvent<T>(
  s: SSEStreamingApi,
  event: T,
): Promise<void> {
  await s.writeSSE({ data: JSON.stringify(event) });
}

/**
 * Write a raw SSE comment line (`: text\n\n`). Comment lines are the
 * standard SSE keep-alive mechanism: browsers' EventSource ignores them
 * natively, and our custom `readSSE` parser on the frontend also drops
 * any line starting with `:`. Used for stream heartbeats that keep
 * CloudFront / Lambda stream connections alive during long Bedrock
 * calls without polluting the typed event stream.
 */
export async function writeComment(
  s: SSEStreamingApi,
  text: string,
): Promise<void> {
  await s.write(`: ${text}\n\n`);
}

/**
 * Start a heartbeat interval that writes an SSE comment every `intervalMs`
 * until cancelled. Returns a cancel function to be called in `finally`.
 *
 * Why this is necessary:
 *   1. CloudFront's default origin-response timeout is 30s — if the origin
 *      hasn't flushed a byte in 30s, CloudFront returns 504 to the client.
 *      A single Bedrock agent round with a 20-template prompt can take
 *      40-60s, and the loop doesn't emit a `tool` event until the round
 *      completes. Without a heartbeat the connection dies mid-round.
 *   2. Between rounds there's also a silent window while the next Bedrock
 *      call runs. Heartbeats during that window keep bytes flowing.
 *
 * The initial comment is written synchronously (well, via the same await
 * chain) so the very first byte leaves the origin immediately — this is
 * what resolves the "first-byte" variant of the 30s timeout.
 */
export function startHeartbeat(
  s: SSEStreamingApi,
  intervalMs = 15_000,
): () => void {
  const timer = setInterval(() => {
    if (s.closed || s.aborted) return;
    // Fire-and-forget: if the write fails (stream closed mid-heartbeat)
    // we simply stop. Not worth logging — the route's own error handling
    // will surface the underlying failure.
    writeComment(s, "heartbeat").catch(() => {});
  }, intervalMs);
  return () => clearInterval(timer);
}
