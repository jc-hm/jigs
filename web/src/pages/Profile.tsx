import { useEffect, useState } from "react";
import { apiFetch, ApiError } from "../lib/api";

interface Usage {
  monthly: { reportCount: number; totalCostUsd: number };
  balance: {
    balanceUsd: number;
    topUpsUsd: number;
    spentUsd: number;
    reportsLifetime: number;
  };
}

// How many times to retry the usage fetch before surfacing an error.
// 3 attempts with 1s spacing covers the typical Lambda cold-start + a
// single DynamoDB throttle window without making the user wait forever
// on a truly-broken endpoint.
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1000;

function isTransient(err: unknown): boolean {
  // Retry on Dynamo-throttled billing reads (429) and anything 5xx —
  // those usually clear within a second or two. Anything else (400
  // validation, 401 unauthenticated, 404 org-not-found) is terminal.
  if (err instanceof ApiError) {
    return err.status === 429 || (err.status >= 500 && err.status < 600);
  }
  // Network errors (TypeError from fetch) are also worth retrying —
  // they're almost always transient connectivity blips.
  return err instanceof TypeError;
}

export function Profile() {
  const [usage, setUsage] = useState<Usage>();
  const [error, setError] = useState<string>();
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    // Guard against setState-after-unmount if the user navigates away
    // while a retry is still pending (Profile → Fill within ~3s).
    let cancelled = false;

    const fetchWithRetry = async () => {
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          const data = await apiFetch<Usage>("/billing/usage");
          if (cancelled) return;
          setUsage(data);
          setError(undefined);
          setIsLoading(false);
          return;
        } catch (e) {
          if (cancelled) return;
          const transient = isTransient(e);
          const isLast = attempt === MAX_ATTEMPTS;
          if (!transient || isLast) {
            setError(e instanceof Error ? e.message : String(e));
            setIsLoading(false);
            return;
          }
          // Wait before the next attempt. Flat 1s spacing is fine here
          // — usage is a single-row read, so if it's throttled the
          // contention clears on the order of a second.
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        }
      }
    };

    fetchWithRetry();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <h1 className="text-2xl font-semibold text-gray-800 mb-6">Profile</h1>

      {isLoading && (
        <div className="p-3 bg-gray-50 border border-gray-200 rounded-lg text-gray-500 text-sm mb-4">
          Loading usage…
        </div>
      )}

      {error && !isLoading && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm mb-4">
          {error}
        </div>
      )}

      {usage && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="bg-white border border-gray-200 rounded-lg p-4">
            <div className="text-sm text-gray-500">Balance</div>
            <div className="text-2xl font-semibold text-gray-800">
              ${usage.balance.balanceUsd.toFixed(2)}
            </div>
            <div className="text-xs text-gray-400">remaining credit</div>
          </div>
          <div className="bg-white border border-gray-200 rounded-lg p-4">
            <div className="text-sm text-gray-500">Total Reports</div>
            <div className="text-2xl font-semibold text-gray-800">
              {usage.balance.reportsLifetime}
            </div>
            <div className="text-xs text-gray-400">lifetime</div>
          </div>
        </div>
      )}
    </div>
  );
}
