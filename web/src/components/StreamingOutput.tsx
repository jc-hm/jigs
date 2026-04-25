import { useState } from "react";
import { useTranslation } from "react-i18next";
import { OUTPUT_TEXT } from "../lib/styles";

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
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  // Collapsed by default after streaming finishes — content already visible
  // in the history block above.
  const [expanded, setExpanded] = useState(false);

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
  // Show the content box while streaming, when the user has expanded it,
  // or when there is no template name to anchor the collapsed row.
  const showContent = isStreaming || expanded || !templateName;

  return (
    <div>
      {/* Link + chevron row — always in the same position, never moves.
          The chevron toggles the content box below without affecting this row. */}
      {templateName && (
        <div className="flex items-center gap-1.5 text-sm text-gray-400 py-0.5 mb-2">
          <span className="italic">{t("output.matchedTemplate")}</span>
          <button
            type="button"
            onClick={() => {
              window.location.hash = `#templates/${templateName}`;
            }}
            className="font-mono hover:text-gray-600 hover:underline transition-colors"
            title={`Open ${templateName} in Templates`}
          >
            {templateName}
          </button>
          {/* Only show toggle during/after streaming — not while the meta
              event is still pending and we have no content yet */}
          {(isStreaming || text.length > 0) && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="flex items-center text-gray-400 hover:text-gray-600 transition-colors"
              title={expanded ? "Collapse" : "Show filled content"}
              aria-label={expanded ? "Collapse" : "Show filled content"}
              disabled={isStreaming}
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 10 10"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                {expanded || isStreaming ? (
                  /* down — content is visible below */
                  <path d="M2 3.5L5 6.5L8 3.5" />
                ) : (
                  /* right — content is hidden, click to reveal */
                  <path d="M3.5 2L6.5 5L3.5 8" />
                )}
              </svg>
            </button>
          )}
        </div>
      )}

      {/* Content box — separate section below the link row */}
      {showContent && (
        <div className="bg-white border border-gray-200 rounded-lg p-4 pr-12 relative">
          {canCopy && (
            <button
              type="button"
              onClick={handleCopy}
              aria-label={copied ? t("output.copied") : t("output.copyToClipboard")}
              title={copied ? t("output.copied") : t("output.copyToClipboard")}
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
          <div className={`${OUTPUT_TEXT}${isStreaming ? " output-streaming" : ""}`}>
            {text}
          </div>
        </div>
      )}
    </div>
  );
}
