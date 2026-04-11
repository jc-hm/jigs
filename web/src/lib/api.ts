import { getIdToken } from "./auth";

const API_BASE = "/api/v1";

// Thrown by `apiFetch` on any non-2xx response. Exposes the HTTP status
// so callers can distinguish transient errors (429, 5xx — worth retrying)
// from terminal ones (400, 401, 404 — not worth retrying) without having
// to parse the message string.
export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function authHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const token = await getIdToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return headers;
}

export async function apiFetch<T>(
  path: string,
  options?: RequestInit
): Promise<T> {
  const headers = await authHeaders();
  const res = await fetch(`${API_BASE}${path}`, {
    headers,
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(
      body.error || `API error: ${res.status}`,
      res.status,
    );
  }
  return res.json();
}

// --- Shared SSE reader ---

/**
 * Read a `text/event-stream` response body and yield each parsed JSON
 * event. Used by both `streamFill` and `streamAgent` so they share one
 * wire-format reader; the event shape is parameterized via `<T>` so each
 * caller stays strictly typed against its own event union.
 *
 * Server side, the matching helper is `api/src/lib/sse.ts#sseLine` (which
 * now delegates to Hono's `streamSSE.writeSSE`).
 *
 * Parsing strategy: split on the SSE event boundary (`\n\n`), NOT on
 * single `\n`, then walk each event block's lines to collect `data:`
 * fields. This is the SSE spec-correct approach and it tolerates:
 *   - multi-line `data:` payloads (joined with `\n`)
 *   - leading `:` comments (keep-alive pings)
 *   - optional space after `data:` (per spec)
 *   - both `\n\n` and `\r\n\r\n` separators
 *
 * Parse failures are logged via `console.warn` (not silently swallowed)
 * so any wire-format issue shows up in the browser console immediately
 * instead of silently dropping events — which was previously making it
 * impossible to tell the difference between "no events arriving" and
 * "events arriving but failing to decode".
 */
async function* readSSE<T>(res: Response): AsyncGenerator<T> {
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `API error: ${res.status}`);
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let buffer = "";

  const flush = function* (): Generator<T> {
    // Normalize CRLF to LF so a single \n\n check works either way.
    let idx;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);

      // Collect all `data:` lines within this event block. Per the SSE
      // spec, multi-line data values are joined with `\n`.
      const dataParts: string[] = [];
      for (const rawLine of block.split("\n")) {
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
        if (line.startsWith(":")) continue; // comment / keep-alive
        if (line.startsWith("data:")) {
          // Strip `data:` and an optional single leading space.
          dataParts.push(line.slice(line[5] === " " ? 6 : 5));
        }
        // other SSE fields (event, id, retry) are ignored for our use case
      }
      if (dataParts.length === 0) continue;

      const dataStr = dataParts.join("\n");
      try {
        yield JSON.parse(dataStr) as T;
      } catch (err) {
        console.warn("readSSE: failed to parse event", {
          dataPreview: dataStr.slice(0, 200),
          err,
        });
      }
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      // Flush anything buffered — and if there's a final event without
      // a trailing `\n\n`, append one so the event boundary check finds it.
      buffer += decoder.decode();
      if (buffer.length > 0 && !buffer.endsWith("\n\n")) buffer += "\n\n";
      yield* flush();
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    // Some servers / proxies emit \r\n\r\n — normalize in the buffer so
    // our indexOf("\n\n") check catches both.
    if (buffer.includes("\r\n")) buffer = buffer.replace(/\r\n/g, "\n");
    yield* flush();
  }
}

// --- Stream events (fill endpoint) ---

export interface StreamEvent {
  type: "meta" | "text" | "done";
  text?: string;
  intent?: string;
  templatePath?: string;
  usage?: { inputTokens: number; outputTokens: number; modelId: string };
}

export async function* streamFill(body: {
  message: string;
  sessionContext?: string;
  conversationHistory?: Array<{ role: "user" | "assistant"; text: string }>;
}): AsyncGenerator<StreamEvent> {
  const headers = await authHeaders();
  const res = await fetch(`${API_BASE}/fill`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  yield* readSSE<StreamEvent>(res);
}

// --- File operations (templates endpoint) ---

export interface FileEntry {
  path: string;
  isDirectory: boolean;
}

// --- Agent stream events ---
//
// Mirrors `api/src/services/ai/types.ts#AgentEvent` exactly. The agent
// endpoint streams these as SSE so the UI can show per-tool progress
// (and retry attempts when Bedrock throttles), instead of waiting on a
// single 60-120s JSON response that CloudFront kills mid-flight.
export type AgentEvent =
  | { type: "tool"; tool: string; path?: string; summary: string }
  | {
      type: "retry";
      attempt: number;
      maxAttempts: number;
      errorName: string;
      delayMs: number;
      action: string;
    }
  | { type: "complete"; message: string; changedPaths: string[] }
  | { type: "error"; message: string };

export async function fileLs(path?: string): Promise<FileEntry[]> {
  const query = path ? `?path=${encodeURIComponent(path)}` : "";
  return apiFetch<FileEntry[]>(`/templates/ls${query}`);
}

export async function fileCat(
  path: string
): Promise<{ path: string; content: string }> {
  return apiFetch(`/templates/cat?path=${encodeURIComponent(path)}`);
}

export async function fileWrite(
  path: string,
  content: string
): Promise<void> {
  await apiFetch("/templates/write", {
    method: "PUT",
    body: JSON.stringify({ path, content }),
  });
}

export async function fileRm(path: string): Promise<void> {
  await apiFetch("/templates/rm", {
    method: "POST",
    body: JSON.stringify({ path }),
  });
}

/** Recursively delete a folder and all its contents. */
export async function fileRmDir(path: string): Promise<void> {
  const entries = await fileLs(path);
  for (const entry of entries) {
    const fullPath = path ? `${path}/${entry.path}` : entry.path;
    if (entry.isDirectory) {
      await fileRmDir(fullPath);
    } else {
      await fileRm(fullPath);
    }
  }
  // Delete the folder marker itself
  await fileRm(path + "/");
}

export async function fileMv(from: string, to: string): Promise<void> {
  await apiFetch("/templates/mv", {
    method: "POST",
    body: JSON.stringify({ from, to }),
  });
}

export async function fileMkdir(path: string): Promise<void> {
  await apiFetch("/templates/mkdir", {
    method: "POST",
    body: JSON.stringify({ path }),
  });
}

export async function* streamAgent(body: {
  message: string;
  conversationHistory?: Array<{ role: "user" | "assistant"; text: string }>;
}): AsyncGenerator<AgentEvent> {
  const headers = await authHeaders();
  const res = await fetch(`${API_BASE}/templates/agent`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  yield* readSSE<AgentEvent>(res);
}
