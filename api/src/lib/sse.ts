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
