import { useState, useEffect, useCallback, useRef, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { streamFill } from "../lib/api";
import { StreamingOutput } from "../components/StreamingOutput";
import { ChatInput } from "../components/ChatInput";
import { CopyButton } from "../components/CopyButton";
import {
  generateSessionId,
  listSessions,
  loadSession,
  saveSession,
  deleteSession,
  isOPFSAvailable,
  type Session,
  type SessionMessage,
  type SessionSummary,
} from "../lib/sessions";

export function Fill() {
  const { t } = useTranslation();
  const [sessionId, setSessionId] = useState(() => generateSessionId());
  const [messages, setMessages] = useState<SessionMessage[]>([]);
  const [input, setInput] = useState("");
  const [output, setOutput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [templatePath, setTemplatePath] = useState<string>();
  const [sessionContext, setSessionContext] = useState<string>();
  const [error, setError] = useState<string>();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Load session list on mount
  useEffect(() => {
    listSessions().then(setSessions);
  }, []);

  // Auto-scroll the conversation to the bottom as new messages land and as
  // the currently streaming response grows. Guarded by a "near-bottom" check
  // so a user who has scrolled up to re-read an earlier interaction isn't
  // yanked back down on every streamed token. Mirrors the same pattern used
  // in Templates.tsx for the agent chat column.
  useEffect(() => {
    const el = chatScrollRef.current;
    if (!el) return;
    const nearBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom) {
      chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, output]);

  // Save session after messages change (debounced by the streaming flow).
  // skipSaveRef is set by handleLoadSession to prevent a spurious save
  // (and updatedAt stamp) when restoring a session from history.
  const saveRef = useRef<Session | null>(null);
  const skipSaveRef = useRef(false);
  useEffect(() => {
    if (messages.length === 0) return;
    if (skipSaveRef.current) {
      skipSaveRef.current = false;
      return;
    }
    const session: Session = {
      id: sessionId,
      title: "",
      templatePath,
      sessionContext,
      createdAt: saveRef.current?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      messages,
    };
    saveRef.current = session;
    saveSession(session).then(() => listSessions().then(setSessions));
  }, [messages, sessionId, templatePath, sessionContext]);

  const handleNewSession = useCallback(() => {
    setSessionId(generateSessionId());
    setMessages([]);
    setOutput("");
    setTemplatePath(undefined);
    setSessionContext(undefined);
    setError(undefined);
    saveRef.current = null;
    inputRef.current?.focus();
  }, []);

  const handleLoadSession = useCallback(async (id: string) => {
    const session = await loadSession(id);
    if (!session) return;
    // Suppress the save effect — loading a session must not update updatedAt,
    // reorder the list, or reset the scroll position.
    skipSaveRef.current = true;
    setSessionId(session.id);
    setMessages(session.messages);
    setTemplatePath(session.templatePath);
    setSessionContext(session.sessionContext);
    setError(undefined);
    saveRef.current = session;
    // Show last assistant message as output
    const lastAssistant = [...session.messages].reverse().find((m) => m.role === "assistant");
    setOutput(lastAssistant?.text ?? "");
    inputRef.current?.focus();
  }, []);

  const handleDeleteSession = useCallback(
    async (id: string, e: React.MouseEvent) => {
      e.stopPropagation();
      await deleteSession(id);
      setSessions((prev) => prev.filter((s) => s.id !== id));
      if (id === sessionId) handleNewSession();
    },
    [sessionId, handleNewSession]
  );

  const handleSubmit = useCallback(
    async (e?: FormEvent) => {
      e?.preventDefault();
      if (!input.trim() || isStreaming) return;

      const userMessage = input.trim();
      setInput("");
      setError(undefined);
      setIsStreaming(true);
      setOutput("");

      const controller = new AbortController();
      abortRef.current = controller;
      let fullText = "";

      try {
        const stream = streamFill(
          {
            message: userMessage,
            sessionContext,
            conversationHistory: messages,
          },
          controller.signal,
        );

        for await (const event of stream) {
          if (event.type === "meta") {
            setTemplatePath(event.templatePath);
            setSessionContext(event.templatePath);
          } else if (event.type === "text") {
            fullText += event.text || "";
            setOutput(fullText);
          } else if (event.type === "done") {
            setMessages((prev) => [
              ...prev,
              { role: "user", text: userMessage },
              { role: "assistant", text: fullText },
            ]);
          }
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          // User clicked stop — save partial response as interrupted
          setMessages((prev) => [
            ...prev,
            { role: "user", text: userMessage },
            {
              role: "assistant",
              text: fullText || "(Response interrupted)",
              interrupted: true,
            },
          ]);
        } else {
          setError(
            err instanceof Error ? err.message : t("fill.errorFallback"),
          );
        }
      } finally {
        abortRef.current = null;
        setIsStreaming(false);
        inputRef.current?.focus();
      }
    },
    [input, isStreaming, sessionContext, messages]
  );

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
  }, []);


  const hasHistory = isOPFSAvailable() || sessions.length > 0;

  return (
    <div className="flex h-full">
      {/* Session sidebar */}
      {hasHistory && (
        <div className="w-56 border-r border-gray-200 bg-white flex flex-col">
          <div className="p-3 border-b border-gray-200 flex items-center justify-between">
            <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">
              {t("fill.sessions")}
            </span>
            <button
              onClick={handleNewSession}
              className="text-xs text-blue-600 hover:text-blue-800 font-medium"
            >
              {t("fill.newSession")}
            </button>
          </div>
          <div className="flex-1 overflow-y-auto">
            {sessions.map((s) => (
              <div
                key={s.id}
                onClick={() => handleLoadSession(s.id)}
                className={`group px-3 py-2 cursor-pointer border-b border-gray-100 hover:bg-gray-50 ${
                  s.id === sessionId ? "bg-blue-50" : ""
                }`}
              >
                <div className="flex items-start justify-between gap-1">
                  <p
                    className={`text-sm truncate flex-1 ${
                      s.id === sessionId
                        ? "text-blue-700 font-medium"
                        : "text-gray-700"
                    }`}
                  >
                    {s.title}
                  </p>
                  <button
                    onClick={(e) => handleDeleteSession(s.id, e)}
                    className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-500 text-xs shrink-0 mt-0.5"
                    title={t("fill.deleteSession")}
                  >
                    &times;
                  </button>
                </div>
                <p className="text-xs text-gray-400 mt-0.5">
                  {formatDate(s.updatedAt)}
                  {s.templatePath && (
                    <span className="ml-1 text-gray-300">
                      · {s.templatePath}
                    </span>
                  )}
                </p>
              </div>
            ))}
            {sessions.length === 0 && (
              <p className="text-xs text-gray-400 p-3">{t("fill.noSessions")}</p>
            )}
          </div>
        </div>
      )}

      {/* Main chat area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Output area */}
        <div ref={chatScrollRef} className="flex-1 overflow-y-auto p-6">
          <div className="max-w-3xl mx-auto">
            {!output && !isStreaming && messages.length === 0 && (
              <div className="text-center text-gray-400 mt-20">
                <h2 className="text-2xl font-semibold text-gray-700 mb-2">
                  Jigs
                </h2>
                <p>{t("fill.emptyHint")}</p>
              </div>
            )}

            {/* Prior messages, grouped into interaction pairs so each pair
                gets a single top-left "copy full interaction" button on hover
                and the assistant code block gets a fixed top-right "copy
                response only" button. Matches the Claude Code chat pattern. */}
            {messages.length > 0 && (
              <div className="space-y-4 mb-6">
                {groupIntoPairs(messages).map((pair) => {
                  const userText = pair.user?.text ?? "";
                  const assistantText = pair.assistant?.text ?? "";
                  const fullInteraction = pair.user && pair.assistant
                    ? `> ${userText}\n\n${assistantText}`
                    : assistantText || userText;
                  return (
                    <div
                      key={pair.key}
                      className="relative group space-y-2"
                    >
                      {/* Hover-only top-left button: copies the whole pair.
                          Sits above the user line so it doesn't overlap the
                          code block's own top-right button. */}
                      {pair.user && pair.assistant && (
                        <CopyButton
                          text={fullInteraction}
                          label={t("fill.copyInteraction")}
                          className="absolute -top-1 -left-1 z-10 opacity-0 group-hover:opacity-100"
                        />
                      )}
                      {pair.user && (
                        <div className="text-sm text-gray-500 italic">
                          <p>{pair.user.text}</p>
                        </div>
                      )}
                      {pair.assistant && (
                        <div className="relative text-sm text-gray-800">
                          {/* Fixed top-right button: copies the response text
                              alone (the "code block" copy). */}
                          <CopyButton
                            text={pair.assistant.text}
                            label={t("fill.copyResponse")}
                            className="absolute top-2 right-2 z-10"
                          />
                          <div
                            className={`bg-white border rounded-lg p-4 pr-12 whitespace-pre-wrap font-mono text-xs ${
                              pair.assistant.interrupted
                                ? "border-amber-200"
                                : "border-gray-200"
                            }`}
                          >
                            {pair.assistant.text}
                          </div>
                          {pair.assistant.interrupted && (
                            <div className="mt-1.5 flex items-center gap-1.5 text-xs text-amber-600">
                              <svg
                                width="14"
                                height="14"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              >
                                <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                                <line x1="12" y1="9" x2="12" y2="13" />
                                <line x1="12" y1="17" x2="12.01" y2="17" />
                              </svg>
                              Response was interrupted
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Current streaming output */}
            {(output || isStreaming) && (
              <StreamingOutput
                text={output}
                isStreaming={isStreaming}
                templateName={templatePath}
              />
            )}
            {error && (
              <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
                {error}
              </div>
            )}
            <div ref={chatEndRef} />
          </div>
        </div>

        {/* Input area */}
        <div className="p-4 pb-5">
          <div className="max-w-3xl mx-auto">
            <ChatInput
              value={input}
              onChange={setInput}
              onSubmit={handleSubmit}
              onStop={handleStop}
              disabled={isStreaming}
              placeholder={t("fill.inputPlaceholder")}
              rows={3}
              submitLabel={t("fill.send")}
              textareaRef={inputRef}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

// Walks the linear messages array and groups each user message with its
// following assistant response into a single "interaction pair". Orphan
// messages (either role missing — e.g. a user prompt still mid-stream, or
// an assistant error without a matching user prompt) are emitted as a
// half-filled pair so they still render but without a full-interaction
// copy button.
function groupIntoPairs(
  messages: SessionMessage[],
): Array<{ key: number; user?: SessionMessage; assistant?: SessionMessage }> {
  const out: Array<{
    key: number;
    user?: SessionMessage;
    assistant?: SessionMessage;
  }> = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "user" && messages[i + 1]?.role === "assistant") {
      out.push({ key: i, user: m, assistant: messages[i + 1] });
      i++;
    } else {
      out.push({ key: i, [m.role]: m });
    }
  }
  return out;
}

function formatDate(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}
