import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { apiFetch, ApiError, createInvite } from "../lib/api";

interface Usage {
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
  const { t } = useTranslation();
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
      <h1 className="text-2xl font-semibold text-gray-800 mb-6">{t("profile.title")}</h1>

      {isLoading && (
        <div className="p-3 bg-gray-50 border border-gray-200 rounded-lg text-gray-500 text-sm mb-4">
          {t("profile.loadingUsage")}
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
            <div className="text-sm text-gray-500">{t("profile.balance")}</div>
            <div className="text-2xl font-semibold text-gray-800">
              ${usage.balance.balanceUsd.toFixed(2)}
            </div>
            <div className="text-xs text-gray-400">{t("profile.remainingCredit")}</div>
          </div>
          <div className="bg-white border border-gray-200 rounded-lg p-4">
            <div className="text-sm text-gray-500">{t("profile.totalReports")}</div>
            <div className="text-2xl font-semibold text-gray-800">
              {usage.balance.reportsLifetime}
            </div>
            <div className="text-xs text-gray-400">{t("profile.lifetime")}</div>
          </div>
        </div>
      )}

      <InviteSection />
    </div>
  );
}

function InviteSection() {
  const { t } = useTranslation();
  const [shareTemplates, setShareTemplates] = useState(true);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ code: string; expiresAt: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const inviteUrl = result
    ? `${window.location.origin}${window.location.pathname}?invite=${result.code}`
    : "";

  const handleGenerate = async () => {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const data = await createInvite(shareTemplates);
      setResult(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to generate link");
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(inviteUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="mt-6 bg-white border border-gray-200 rounded-lg p-4">
      <h2 className="text-sm font-medium text-gray-700 mb-3">{t("profile.inviteTitle")}</h2>

      <label className="flex items-center gap-2 text-sm text-gray-600 mb-4 cursor-pointer">
        <input
          type="checkbox"
          checked={shareTemplates}
          onChange={(e) => setShareTemplates(e.target.checked)}
          className="accent-blue-500"
        />
        {t("profile.shareTemplates")}
      </label>

      {error && (
        <p className="text-red-600 text-xs mb-3">{error}</p>
      )}

      {result ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <input
              type="text"
              readOnly
              value={inviteUrl}
              className="flex-1 px-3 py-1.5 border border-gray-200 rounded-lg text-xs text-gray-700 bg-gray-50 focus:outline-none"
            />
            <button
              onClick={handleCopy}
              className="px-3 py-1.5 bg-blue-600 text-white rounded-lg text-xs font-medium hover:bg-blue-700 transition-colors"
            >
              {copied ? t("profile.linkCopied") : t("profile.copyLink")}
            </button>
          </div>
          <p className="text-xs text-gray-400">
            {t("profile.inviteExpiry", {
              date: new Date(result.expiresAt).toLocaleDateString(),
            })}
          </p>
        </div>
      ) : (
        <button
          onClick={handleGenerate}
          disabled={loading}
          className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors disabled:opacity-50"
        >
          {loading ? t("profile.generating") : t("profile.generateLink")}
        </button>
      )}
    </div>
  );
}
