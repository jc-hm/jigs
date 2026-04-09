import { getIdToken } from "./auth";

const API_BASE = "/api/v1";

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
    throw new Error(body.error || `API error: ${res.status}`);
  }
  return res.json();
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

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `API error: ${res.status}`);
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (line.startsWith("data: ")) {
        try {
          const event: StreamEvent = JSON.parse(line.slice(6));
          yield event;
        } catch {
          // skip malformed events
        }
      }
    }
  }
}

// --- File operations (templates endpoint) ---

export interface FileEntry {
  path: string;
  isDirectory: boolean;
}

export interface AgentResult {
  actions: Array<{ tool: string; path?: string; summary: string }>;
  message: string;
  changedPaths: string[];
}

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

export async function runAgent(message: string): Promise<AgentResult> {
  return apiFetch<AgentResult>("/templates/agent", {
    method: "POST",
    body: JSON.stringify({ message }),
  });
}
