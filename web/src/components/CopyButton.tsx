import { useState } from "react";
import { useTranslation } from "react-i18next";

interface CopyButtonProps {
  /** Text to write to the clipboard when clicked. */
  text: string;
  /** Tooltip/aria label. Overridden to "Copied" briefly after a successful copy. */
  label?: string;
  /**
   * Extra classes — typically used for absolute positioning (e.g.
   * `absolute top-2 right-2`) and hover visibility
   * (`opacity-0 group-hover:opacity-100`).
   */
  className?: string;
}

/**
 * Shared "click to copy" button. Two visual states:
 *   - default: two-squares icon
 *   - copied (1.5s after successful copy): checkmark
 *
 * Styling intentionally keeps only the minimal visual (padding, rounded,
 * hover color). Positioning and hover-visibility are the caller's job via
 * `className` so the same button works for both "fixed top-right of a code
 * block" and "top-left that appears on hover over a whole interaction."
 *
 * Clipboard errors (blocked, insecure context) are swallowed — the button
 * simply stays in its default state. No error toast because this is a
 * quality-of-life affordance, not a primary flow.
 */
export function CopyButton({
  text,
  label,
  className = "",
}: CopyButtonProps) {
  const { t } = useTranslation();
  const resolvedLabel = label ?? t("copy.label");
  const [copied, setCopied] = useState(false);

  const handleClick = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard blocked — silently ignore
    }
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label={copied ? t("copy.copied") : resolvedLabel}
      title={copied ? t("copy.copied") : resolvedLabel}
      className={`p-1.5 rounded-md text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors ${className}`}
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
  );
}
