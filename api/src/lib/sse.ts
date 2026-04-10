/**
 * Format a value as a single SSE `data:` line. Used by every streaming
 * endpoint (fill, agent) so they share one wire-format primitive.
 *
 * The protocol is intentionally minimal: one JSON event per line, with
 * the trailing `\n\n` separator that browsers' EventSource (and our own
 * client-side `readSSE` reader) expect. Discriminated-union event types
 * live with the service that emits them (FillChunk in ai/types.ts,
 * AgentEvent likewise) — this helper stays event-agnostic.
 */
export function sseLine<T>(event: T): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}
