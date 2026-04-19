import { useState, type FormEvent } from "react";
import { submitWaitlist } from "../lib/api";
import { FeedbackForm } from "./FeedbackForm";

interface LandingPageProps {
  onSignIn: () => void;
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

type FooterPanel = "contact" | null;

export function LandingPage({ onSignIn }: LandingPageProps) {
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteNote, setInviteNote] = useState("");
  const [inviteLoading, setInviteLoading] = useState(false);
  const [inviteDone, setInviteDone] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [footerPanel, setFooterPanel] = useState<FooterPanel>(null);

  const handleInviteSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setInviteLoading(true);
    setInviteError(null);
    try {
      await submitWaitlist(inviteEmail, inviteNote || undefined);
      setInviteDone(true);
    } catch (err) {
      setInviteError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setInviteLoading(false);
    }
  };

  const toggleFooter = (panel: FooterPanel) => {
    setFooterPanel((prev) => (prev === panel ? null : panel));
  };

  return (
    <div className="min-h-screen bg-white flex flex-col">
      {/* Sticky header */}
      <header className="fixed top-0 inset-x-0 z-10 bg-white/90 backdrop-blur-sm border-b border-gray-100">
        <div className="max-w-4xl mx-auto px-6 h-14 flex items-center justify-between">
          <span className="text-sm font-semibold text-gray-800 tracking-tight">
            Template filling, simplified.
          </span>
          <button
            onClick={onSignIn}
            className="px-4 py-1.5 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
          >
            Sign in
          </button>
        </div>
      </header>

      {/* Hero */}
      <section className="flex-1 flex flex-col items-center justify-center text-center px-6 pt-28 pb-20">
        <span className="inline-block mb-6 px-3 py-1 text-xs font-medium bg-amber-50 text-amber-700 border border-amber-200 rounded-full">
          Private beta · Invite only
        </span>

        <h1 className="text-4xl sm:text-5xl font-bold text-gray-900 tracking-tight max-w-xl leading-tight">
          Fill templates by talking.
        </h1>

        <p className="mt-4 text-lg text-gray-500 max-w-md">
          Describe what goes in the template. Get it filled in seconds.
        </p>

        <div className="mt-8 flex flex-col items-center gap-3 w-full max-w-sm">
          {!inviteOpen && !inviteDone && (
            <div className="flex items-center gap-4">
              <button
                onClick={() => setInviteOpen(true)}
                className="px-5 py-2.5 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
              >
                Request an invite
              </button>
              <button
                onClick={onSignIn}
                className="text-sm text-gray-500 hover:text-gray-800 transition-colors"
              >
                Sign in →
              </button>
            </div>
          )}

          {inviteOpen && !inviteDone && (
            <form onSubmit={handleInviteSubmit} className="w-full space-y-2">
              <input
                type="email"
                placeholder="your@email.com"
                required
                autoFocus
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <input
                type="text"
                placeholder="Tell us about your use case (optional)"
                value={inviteNote}
                onChange={(e) => setInviteNote(e.target.value)}
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
                  {inviteLoading ? "Sending…" : "Request invite"}
                </button>
                <button
                  type="button"
                  onClick={() => setInviteOpen(false)}
                  className="px-4 py-2 text-sm text-gray-400 hover:text-gray-600 transition-colors"
                >
                  Cancel
                </button>
              </div>
            </form>
          )}

          {inviteDone && (
            <p className="text-sm text-gray-600">
              You're on the list. We'll be in touch.
            </p>
          )}
        </div>
      </section>

      {/* How it works */}
      <section className="bg-gray-50 px-6 py-16">
        <div className="max-w-3xl mx-auto">
          <h2 className="text-xs font-semibold uppercase tracking-widest text-gray-400 text-center mb-10">
            How it works
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-8">
            {[
              {
                icon: <MicIcon />,
                title: "Describe",
                body: "Say what goes in the template — in your own words, as fast as you can speak.",
              },
              {
                icon: <SparkleIcon />,
                title: "Fills itself",
                body: "The template is filled in seconds. No formatting, no copy-paste.",
              },
              {
                icon: <ClipboardIcon />,
                title: "Copy",
                body: "One click copies the filled result. You're done.",
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
            Your data, simply.
          </h2>
          <div className="space-y-3 text-sm text-gray-500 leading-relaxed">
            <p>
              We store your email address and usage counts to manage your account.
              Your templates — the files you create — are stored securely on AWS infrastructure.
            </p>
            <p>
              When you fill a template, your description and the template are sent to
              AWS's AI service to generate the result. That content is not retained after
              the request completes, and AWS does not use it to train AI models.{" "}
              <a
                href="https://aws.amazon.com/bedrock/security-privacy-responsible-ai/"
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-500 hover:underline"
              >
                AWS Bedrock privacy ↗
              </a>
            </p>
            <p>
              Your activity history is saved in your own browser's local storage for
              your convenience — not on our servers.
            </p>
            <p>No tracking cookies. No analytics.</p>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-gray-100 px-6 py-6">
        <div className="max-w-2xl mx-auto">
          <div className="flex items-center gap-4 text-xs text-gray-400">
            <a
              href="#privacy"
              onClick={(e) => {
                e.preventDefault();
                document.getElementById("privacy")?.scrollIntoView({ behavior: "smooth" });
              }}
              className="hover:text-gray-600 transition-colors"
            >
              Privacy
            </a>
            <span>·</span>
            <button
              onClick={() => toggleFooter("contact")}
              className="hover:text-gray-600 transition-colors"
            >
              {footerPanel === "contact" ? "Close" : "Contact"}
            </button>
          </div>

          {footerPanel === "contact" && (
            <div className="mt-4 max-w-sm">
              <FeedbackForm
                mode="public"
                page="landing"
                onClose={() => setFooterPanel(null)}
              />
            </div>
          )}
        </div>
      </footer>
    </div>
  );
}
