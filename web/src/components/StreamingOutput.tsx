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
  if (!text && !isStreaming) return null;

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-6 shadow-sm">
      {templateName && (
        <div className="text-sm text-gray-500 mb-3 pb-2 border-b border-gray-100">
          Template: {templateName}
        </div>
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
