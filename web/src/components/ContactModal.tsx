import { FeedbackForm } from "./FeedbackForm";

export function ContactModal({
  mode,
  page,
  onClose,
}: {
  mode: "public" | "authenticated";
  page?: string;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/20"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl shadow-xl p-6 w-full max-w-sm mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <p className="text-sm font-semibold text-gray-800">Contact</p>
          <button
            onClick={onClose}
            className="text-xl leading-none text-gray-400 hover:text-gray-600 transition-colors"
          >
            ×
          </button>
        </div>
        <FeedbackForm mode={mode} page={page} onClose={onClose} />
      </div>
    </div>
  );
}
