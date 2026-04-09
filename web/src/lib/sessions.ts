// ---------------------------------------------------------------------------
// Session storage — OPFS (Origin Private File System)
//
// Directory structure:
//   sessions/{userId}/
//     {id}.json
//
// Each user gets an isolated directory keyed by Cognito sub (UUID).
// Falls back to in-memory storage when OPFS is unavailable (Safari).
// ---------------------------------------------------------------------------

import { getCurrentUserId } from "./auth";

export interface SessionMessage {
  role: "user" | "assistant";
  text: string;
}

export interface Session {
  id: string;
  title: string; // derived from first user message
  templatePath?: string;
  createdAt: number;
  updatedAt: number;
  sessionContext?: string;
  messages: SessionMessage[];
}

export interface SessionSummary {
  id: string;
  title: string;
  templatePath?: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

// ---------------------------------------------------------------------------
// Feature detection
// ---------------------------------------------------------------------------

export function isOPFSAvailable(): boolean {
  return typeof navigator !== "undefined" && "storage" in navigator && "getDirectory" in navigator.storage;
}

// ---------------------------------------------------------------------------
// OPFS helpers
// ---------------------------------------------------------------------------

async function getUserDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  const sessions = await root.getDirectoryHandle("sessions", { create: true });
  const userId = getCurrentUserId();
  return sessions.getDirectoryHandle(userId, { create: true });
}

async function readFile(dir: FileSystemDirectoryHandle, name: string): Promise<string> {
  const handle = await dir.getFileHandle(name);
  const file = await handle.getFile();
  return file.text();
}

async function writeFile(dir: FileSystemDirectoryHandle, name: string, content: string): Promise<void> {
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(content);
  await writable.close();
}

// ---------------------------------------------------------------------------
// In-memory fallback (Safari / unsupported browsers)
// ---------------------------------------------------------------------------

const memoryStore = new Map<string, Session>();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function generateSessionId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function sessionTitle(messages: SessionMessage[]): string {
  const first = messages.find((m) => m.role === "user");
  if (!first) return "New session";
  const text = first.text.trim();
  return text.length > 60 ? text.slice(0, 57) + "..." : text;
}

export async function listSessions(): Promise<SessionSummary[]> {
  if (!isOPFSAvailable()) {
    return Array.from(memoryStore.values())
      .map(toSummary)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  const dir = await getUserDir();
  const summaries: SessionSummary[] = [];

  // values() exists at runtime but is missing from TS DOM types
  const iter = (dir as unknown as { values(): AsyncIterable<FileSystemHandle & { name: string }> }).values();
  for await (const handle of iter) {
    if (handle.kind !== "file" || !handle.name.endsWith(".json")) continue;
    try {
      const text = await readFile(dir, handle.name);
      const session: Session = JSON.parse(text);
      summaries.push(toSummary(session));
    } catch {
      // skip corrupt files
    }
  }

  return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function loadSession(id: string): Promise<Session | null> {
  if (!isOPFSAvailable()) {
    return memoryStore.get(id) ?? null;
  }

  try {
    const dir = await getUserDir();
    const text = await readFile(dir, `${id}.json`);
    return JSON.parse(text) as Session;
  } catch {
    return null;
  }
}

export async function saveSession(session: Session): Promise<void> {
  session.updatedAt = Date.now();
  session.title = sessionTitle(session.messages);

  if (!isOPFSAvailable()) {
    memoryStore.set(session.id, structuredClone(session));
    return;
  }

  const dir = await getUserDir();
  await writeFile(dir, `${session.id}.json`, JSON.stringify(session));
}

export async function deleteSession(id: string): Promise<void> {
  if (!isOPFSAvailable()) {
    memoryStore.delete(id);
    return;
  }

  try {
    const dir = await getUserDir();
    await dir.removeEntry(`${id}.json`);
  } catch {
    // already deleted
  }
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function toSummary(s: Session): SessionSummary {
  return {
    id: s.id,
    title: s.title,
    templatePath: s.templatePath,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    messageCount: s.messages.length,
  };
}
