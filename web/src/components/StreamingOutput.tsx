import { useState } from "react";

interface StreamingOutputProps {
  text: string;
  isStreaming: boolean;
  templateName?: string;
}

export function StreamingOutput({
  text,
  isStreaming,
  templateName,
}: StreamingOutputProps) {
  const [copied, setCopied] = useState(false);

  if (!text && !isStreaming) return null;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard blocked — silently ignore
    }
  };

  const canCopy = text.length > 0 && !isStreaming;

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-6 shadow-sm relative">
      {templateName && (
        <div className="text-sm text-gray-500 mb-3 pb-2 border-b border-gray-100">
          Template: {templateName}
        </div>
      )}
      {canCopy && (
        <button
          type="button"
          onClick={handleCopy}
          aria-label={copied ? "Copied" : "Copy to clipboard"}
          title={copied ? "Copied" : "Copy to clipboard"}
          className="absolute top-3 right-3 p-1.5 rounded-md text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors"
        >
          {copied ? (
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="20 6 9 17 4 12" />
            </svg>
          ) : (
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
          )}
        </button>
      )}
      <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-gray-800">
        {text}
        {isStreaming && (
          <span className="inline-block w-2 h-4 bg-blue-500 animate-pulse ml-0.5" />
        )}
      </pre>
    </div>
  );
}
