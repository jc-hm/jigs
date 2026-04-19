import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { submitWaitlist } from "../lib/api";
import { ContactModal } from "./ContactModal";

interface LandingPageProps {
  onSignIn: () => void;
  onSignUp: () => void;
}

function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="w-8 h-8">
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10a7 7 0 0 0 14 0" strokeLinecap="round" />
      <line x1="12" y1="17" x2="12" y2="21" strokeLinecap="round" />
      <line x1="8" y1="21" x2="16" y2="21" strokeLinecap="round" />
    </svg>
  );
}

function SparkleIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="w-8 h-8">
      <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" strokeLinecap="round" />
    </svg>
  );
}

function ClipboardIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="w-8 h-8">
      <rect x="9" y="2" width="6" height="4" rx="1" />
      <path d="M8 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2" />
      <line x1="9" y1="12" x2="15" y2="12" strokeLinecap="round" />
      <line x1="9" y1="15" x2="13" y2="15" strokeLinecap="round" />
    </svg>
  );
}

export function LandingPage({ onSignIn, onSignUp }: LandingPageProps) {
  const { t } = useTranslation();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteLoading, setInviteLoading] = useState(false);
  const [inviteDone, setInviteDone] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [contactOpen, setContactOpen] = useState(false);

  const handleInviteSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setInviteLoading(true);
    setInviteError(null);
    try {
      await submitWaitlist(inviteEmail);
      setInviteDone(true);
    } catch (err) {
      setInviteError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setInviteLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-white flex flex-col">
      {/* Sticky header */}
      <header className="fixed top-0 inset-x-0 z-10 bg-white/90 backdrop-blur-sm border-b border-gray-100">
        <div className="max-w-4xl mx-auto px-6 h-14 flex items-center justify-between">
          <span className="text-sm font-semibold text-gray-800 tracking-tight">
            {t("landing.tagline")}
          </span>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setContactOpen(true)}
              className="text-sm text-gray-400 hover:text-gray-600 transition-colors"
            >
              {t("landing.contact")}
            </button>
            <button
              onClick={onSignIn}
              className="px-4 py-1.5 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
            >
              {t("landing.signIn")}
            </button>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="flex-1 flex flex-col items-center justify-center text-center px-6 pt-28 pb-20">
        <h1 className="text-4xl sm:text-5xl font-bold text-gray-900 tracking-tight max-w-xl leading-tight">
          {t("landing.headline")}
        </h1>

        <p className="mt-4 text-lg text-gray-500 max-w-md">
          {t("landing.subhead")}
        </p>

        <div className="mt-8 flex flex-col items-center gap-3 w-full max-w-sm">
          {!inviteOpen && !inviteDone && (
            <div className="flex items-center gap-4">
              <button
                onClick={() => setInviteOpen(true)}
                className="px-5 py-2.5 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
              >
                {t("landing.requestInvite")}
              </button>
              <button
                onClick={onSignUp}
                className="text-sm text-gray-500 hover:text-gray-800 transition-colors"
              >
                {t("landing.signUp")}
              </button>
            </div>
          )}

          {inviteOpen && !inviteDone && (
            <form onSubmit={handleInviteSubmit} className="w-full space-y-2">
              <input
                type="email"
                placeholder={t("landing.emailPlaceholder")}
                required
                autoFocus
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              {inviteError && (
                <p className="text-xs text-red-600 text-left">{inviteError}</p>
              )}
              <div className="flex gap-2">
                <button
                  type="submit"
                  disabled={inviteLoading}
                  className="flex-1 py-2 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
                >
                  {inviteLoading ? t("landing.sending") : t("landing.requestInviteSubmit")}
                </button>
                <button
                  type="button"
                  onClick={() => setInviteOpen(false)}
                  className="px-4 py-2 text-sm text-gray-400 hover:text-gray-600 transition-colors"
                >
                  {t("landing.cancel")}
                </button>
              </div>
            </form>
          )}

          {inviteDone && (
            <p className="text-sm text-gray-600">
              {t("landing.inviteSent")}
            </p>
          )}
        </div>
      </section>

      {/* How it works */}
      <section className="bg-gray-50 px-6 py-16">
        <div className="max-w-3xl mx-auto">
          <h2 className="text-xs font-semibold uppercase tracking-widest text-gray-400 text-center mb-10">
            {t("landing.howItWorksTitle")}
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-8">
            {[
              {
                icon: <MicIcon />,
                title: t("landing.step1Title"),
                body: t("landing.step1Body"),
              },
              {
                icon: <SparkleIcon />,
                title: t("landing.step2Title"),
                body: t("landing.step2Body"),
              },
              {
                icon: <ClipboardIcon />,
                title: t("landing.step3Title"),
                body: t("landing.step3Body"),
              },
            ].map((step) => (
              <div key={step.title} className="flex flex-col items-center text-center gap-3">
                <div className="text-blue-500">{step.icon}</div>
                <p className="text-sm font-semibold text-gray-800">{step.title}</p>
                <p className="text-sm text-gray-500 leading-relaxed">{step.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Privacy */}
      <section id="privacy" className="px-6 py-14">
        <div className="max-w-2xl mx-auto">
          <h2 className="text-xs font-semibold uppercase tracking-widest text-gray-400 mb-6">
            {t("landing.privacyTitle")}
          </h2>
          <div className="space-y-3 text-sm text-gray-500 leading-relaxed">
            <p>{t("landing.privacyP1")}</p>
            <p>
              {t("landing.privacyP2Before")}{" "}
              <a
                href="https://aws.amazon.com/bedrock/security-privacy-responsible-ai/"
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-500 hover:underline"
              >
                {t("landing.privacyLinkText")}
              </a>
            </p>
            <p>{t("landing.privacyP3")}</p>
            <p>{t("landing.privacyP4")}</p>
          </div>
        </div>
      </section>

      {contactOpen && (
        <ContactModal mode="public" page="landing" onClose={() => setContactOpen(false)} />
      )}
    </div>
  );
}
