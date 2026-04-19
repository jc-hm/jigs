import { useState, type FormEvent } from "react";
import { submitFeedback, submitAuthFeedback } from "../lib/api";

interface FeedbackFormProps {
  mode: "public" | "authenticated";
  page?: string;
  onClose?: () => void;
}

export function FeedbackForm({ mode, page, onClose }: FeedbackFormProps) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      if (mode === "public") {
        await submitFeedback({
          content,
          senderEmail: email,
          ...(name.trim() && { senderName: name.trim() }),
          ...(page && { context: { page } }),
        });
      } else {
        await submitAuthFeedback({
          content,
          ...(page && { context: { page } }),
        });
      }
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  };

  if (done) {
    return (
      <div className="text-center py-4">
        <p className="text-sm text-gray-700 font-medium">Message sent. Thanks!</p>
        {onClose && (
          <button
            onClick={onClose}
            className="mt-3 text-xs text-gray-400 hover:text-gray-600 transition-colors"
          >
            Close
          </button>
        )}
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      {mode === "public" && (
        <>
          <input
            type="text"
            placeholder="Name (optional)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <input
            type="email"
            placeholder="Email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </>
      )}
      <textarea
        placeholder="Your message…"
        required
        rows={4}
        value={content}
        onChange={(e) => setContent(e.target.value)}
        className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
      />
      {error && <p className="text-xs text-red-600">{error}</p>}
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={loading}
          className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
        >
          {loading ? "Sending…" : "Send"}
        </button>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="text-sm text-gray-400 hover:text-gray-600 transition-colors"
          >
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
