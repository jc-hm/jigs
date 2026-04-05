const API_BASE = "/api/v1";

export async function apiFetch<T>(
  path: string,
  options?: RequestInit
): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: {
      "Content-Type": "application/json",
      // TODO: Add Cognito JWT token
      // "Authorization": `Bearer ${getToken()}`,
    },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `API error: ${res.status}`);
  }
  return res.json();
}

export interface StreamEvent {
  type: "meta" | "text" | "done";
  text?: string;
  intent?: string;
  templateId?: string;
  templateName?: string;
  usage?: { inputTokens: number; outputTokens: number; modelId: string };
}

export async function* streamFill(body: {
  skillId: string;
  message: string;
  sessionContext?: string;
  conversationHistory?: Array<{ role: "user" | "assistant"; text: string }>;
}): AsyncGenerator<StreamEvent> {
  const res = await fetch(`${API_BASE}/fill`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
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
