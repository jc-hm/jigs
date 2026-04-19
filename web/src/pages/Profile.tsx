import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { apiFetch, ApiError, createInvite } from "../lib/api";
import { changePassword } from "../lib/auth";

interface Usage {
  email: string | null;
  balance: {
    balanceUsd: number;
    topUpsUsd: number;
    spentUsd: number;
    reportsLifetime: number;
  };
}

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1000;

function isTransient(err: unknown): boolean {
  if (err instanceof ApiError) {
    return err.status === 429 || (err.status >= 500 && err.status < 600);
  }
  return err instanceof TypeError;
}

export function Profile() {
  const { t } = useTranslation();
  const [usage, setUsage] = useState<Usage>();
  const [error, setError] = useState<string>();
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
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

      <AccountSection email={usage?.email ?? null} />

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

function AccountSection({ email }: { email: string | null }) {
  const { t } = useTranslation();
  const [showChangePassword, setShowChangePassword] = useState(false);

  return (
    <div className="mb-6 bg-white border border-gray-200 rounded-lg p-4">
      <h2 className="text-sm font-medium text-gray-700 mb-3">{t("profile.account")}</h2>
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs text-gray-400 mb-0.5">{t("profile.email")}</div>
          <div className="text-sm text-gray-700">{email ?? "—"}</div>
        </div>
        <button
          onClick={() => setShowChangePassword((v) => !v)}
          className="text-xs text-blue-600 hover:text-blue-700 transition-colors"
        >
          {t("profile.changePasswordTitle")}
        </button>
      </div>
      {showChangePassword && (
        <div className="mt-4 border-t border-gray-100 pt-4">
          <ChangePasswordForm onDone={() => setShowChangePassword(false)} />
        </div>
      )}
    </div>
  );
}

function ChangePasswordForm({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      setError(t("profile.passwordMismatch"));
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await changePassword(oldPassword, newPassword);
      setDone(true);
      setTimeout(onDone, 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  };

  if (done) {
    return (
      <p className="text-sm text-green-600">{t("profile.passwordChanged")}</p>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-2">
      <input
        type="password"
        placeholder={t("profile.currentPassword")}
        required
        value={oldPassword}
        onChange={(e) => setOldPassword(e.target.value)}
        className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
      <input
        type="password"
        placeholder={t("profile.newPassword")}
        required
        value={newPassword}
        onChange={(e) => setNewPassword(e.target.value)}
        className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
      <input
        type="password"
        placeholder={t("profile.confirmPassword")}
        required
        value={confirmPassword}
        onChange={(e) => setConfirmPassword(e.target.value)}
        className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
      {error && <p className="text-xs text-red-600">{error}</p>}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={loading}
          className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
        >
          {loading ? t("profile.changingPassword") : t("profile.changePasswordSubmit")}
        </button>
        <button
          type="button"
          onClick={onDone}
          className="px-4 py-2 text-sm text-gray-400 hover:text-gray-600 transition-colors"
        >
          {t("feedback.cancel")}
        </button>
      </div>
    </form>
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
