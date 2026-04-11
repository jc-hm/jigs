/**
 * Parse the text body of a `text/event-stream` response into a typed array
 * of JSON-decoded events. Mirrors `web/src/lib/api.ts#readSSE` but works on
 * the final body string returned by `app.request()` in Vitest — we can't
 * use the real streaming reader there because the body is already buffered.
 *
 * Handles:
 *   - multiple `data:` lines joined per SSE spec
 *   - leading `:` comment lines (keep-alives like `: start` / `: heartbeat`)
 *   - optional single space after `data:`
 *   - CRLF or LF event separators
 */
export function parseSSE<T>(text: string): T[] {
  const normalized = text.replace(/\r\n/g, "\n");
  const blocks = normalized.split("\n\n").filter((b) => b.length > 0);
  const events: T[] = [];
  for (const block of blocks) {
    const dataParts: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith(":")) continue; // comment / keep-alive
      if (line.startsWith("data:")) {
        dataParts.push(line.slice(line[5] === " " ? 6 : 5));
      }
    }
    if (dataParts.length === 0) continue;
    events.push(JSON.parse(dataParts.join("\n")) as T);
  }
  return events;
}
