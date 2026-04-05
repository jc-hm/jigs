import { useState, useCallback, useRef, type FormEvent } from "react";
import { streamFill } from "../lib/api";
import { StreamingOutput } from "../components/StreamingOutput";
import { VoiceInput } from "../components/VoiceInput";

interface Message {
  role: "user" | "assistant";
  text: string;
}

export function Fill() {
  const [input, setInput] = useState("");
  const [output, setOutput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [templateName, setTemplateName] = useState<string>();
  const [sessionTemplateId, setSessionTemplateId] = useState<string>();
  const [messages, setMessages] = useState<Message[]>([]);
  const [error, setError] = useState<string>();
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const handleSubmit = useCallback(
    async (e?: FormEvent) => {
      e?.preventDefault();
      if (!input.trim() || isStreaming) return;

      const userMessage = input.trim();
      setInput("");
      setError(undefined);
      setIsStreaming(true);
      setOutput("");

      try {
        let fullText = "";
        const stream = streamFill({
          skillId: "radiology",
          message: userMessage,
          sessionContext: sessionTemplateId,
          conversationHistory: messages,
        });

        for await (const event of stream) {
          if (event.type === "meta") {
            setTemplateName(event.templateName);
            setSessionTemplateId(event.templateId);
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
        setError(err instanceof Error ? err.message : "Something went wrong");
      } finally {
        setIsStreaming(false);
        inputRef.current?.focus();
      }
    },
    [input, isStreaming, sessionTemplateId, messages]
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="flex flex-col h-screen">
      {/* Output area */}
      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-3xl mx-auto">
          {!output && !isStreaming && (
            <div className="text-center text-gray-400 mt-20">
              <h2 className="text-2xl font-semibold text-gray-700 mb-2">
                Jigs
              </h2>
              <p>
                Describe a study to generate a report. Try: "Left knee MRI, ACL
                complete tear, small joint effusion"
              </p>
            </div>
          )}
          <StreamingOutput
            text={output}
            isStreaming={isStreaming}
            templateName={templateName}
          />
          {error && (
            <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
              {error}
            </div>
          )}
        </div>
      </div>

      {/* Input area */}
      <div className="border-t border-gray-200 bg-white p-4">
        <form
          onSubmit={handleSubmit}
          className="max-w-3xl mx-auto flex gap-2 items-end"
        >
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Describe a study or refine the current report..."
            rows={2}
            disabled={isStreaming}
            className="flex-1 resize-none rounded-lg border border-gray-300 px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:opacity-50"
          />
          <VoiceInput
            onTranscript={setInput}
            disabled={isStreaming}
          />
          <button
            type="submit"
            disabled={!input.trim() || isStreaming}
            className="px-4 py-3 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50 disabled:hover:bg-blue-600 transition-colors"
          >
            {isStreaming ? "..." : "Send"}
          </button>
        </form>
      </div>
    </div>
  );
}
