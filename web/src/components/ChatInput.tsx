import { useRef, type FormEvent, type KeyboardEvent, type RefObject } from "react";
import { VoiceInput } from "./VoiceInput";

interface ChatInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (e?: FormEvent) => void;
  /** If provided and `disabled` is true, a stop button is shown instead of send. */
  onStop?: () => void;
  /** True while the parent is busy (streaming / processing). Disables textarea and send. */
  disabled?: boolean;
  placeholder: string;
  rows?: number;
  submitLabel: string;
  /** Forward a ref to the internal textarea so callers can focus it. */
  textareaRef?: RefObject<HTMLTextAreaElement>;
}

export function ChatInput({
  value,
  onChange,
  onSubmit,
  onStop,
  disabled = false,
  placeholder,
  rows = 3,
  submitLabel,
  textareaRef: externalRef,
}: ChatInputProps) {
  const internalRef = useRef<HTMLTextAreaElement>(null);
  const inputRef = (externalRef ?? internalRef) as RefObject<HTMLTextAreaElement>;

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSubmit();
    }
  };

  const showStop = disabled && !!onStop;

  return (
    <form onSubmit={(e) => { e.preventDefault(); onSubmit(e); }}>
      <div className="rounded-2xl border border-gray-200 bg-white shadow-sm focus-within:ring-2 focus-within:ring-blue-500 focus-within:border-transparent transition-shadow">
        <textarea
          ref={inputRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          rows={rows}
          disabled={disabled}
          className="w-full resize-none px-4 pt-3 pb-1 text-sm focus:outline-none bg-transparent disabled:opacity-50"
        />
        <div className="flex items-center justify-end px-3 pb-2.5 gap-1">
          <VoiceInput
            onTranscript={onChange}
            disabled={disabled}
            inputRef={inputRef}
          />
          {showStop ? (
            <button
              type="button"
              onClick={onStop}
              className="w-8 h-8 flex items-center justify-center rounded-full bg-gray-600 text-white hover:bg-gray-700 transition-colors shrink-0"
              title="Stop"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <rect x="4" y="4" width="16" height="16" rx="2" />
              </svg>
            </button>
          ) : (
            <button
              type="submit"
              disabled={!value.trim() || disabled}
              className="w-8 h-8 flex items-center justify-center rounded-full bg-blue-600 text-white hover:bg-blue-700 disabled:bg-gray-200 disabled:text-gray-400 transition-colors shrink-0"
              title={submitLabel}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12 19V5M5 12l7-7 7 7" />
              </svg>
            </button>
          )}
        </div>
      </div>
    </form>
  );
}
