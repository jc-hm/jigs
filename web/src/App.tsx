import { useState, useEffect, useCallback } from "react";
import type { FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Fill } from "./pages/Fill";
import { Templates } from "./pages/Templates";
import { Profile } from "./pages/Profile";
import { Admin } from "./pages/Admin";
import {
  loadAuthConfig,
  getIdToken,
  signIn,
  signUp,
  confirmSignUp,
  resendCode,
  signOut,
} from "./lib/auth";
import { getInvite } from "./lib/api";
import { LandingPage } from "./components/LandingPage";
import { ContactModal } from "./components/ContactModal";

type Page = "fill" | "templates" | "profile";
type AuthState = "loading" | "authenticated" | "unauthenticated" | "error";

const VALID_PAGES: Page[] = ["fill", "templates", "profile"];

// Parse `#page/subpath/more` into a page + optional sub-path. Used by the
// Templates page so `#templates/neuro/brain-mri.md` reloads land on the
// same file (and, via the matched-template link on Fill, lets the user
// jump straight from a fill response to editing the template that
// produced it). Only the first segment is validated as a Page — anything
// after the first slash is forwarded as-is.
function parseHash(): { page: Page; subpath: string } {
  const raw = window.location.hash.replace(/^#/, "");
  const slash = raw.indexOf("/");
  const first = slash === -1 ? raw : raw.slice(0, slash);
  const subpath = slash === -1 ? "" : raw.slice(slash + 1);
  const page: Page = VALID_PAGES.includes(first as Page)
    ? (first as Page)
    : "fill";
  return { page, subpath };
}

// URL-based auth navigation (persistent, back-button-friendly):
//   ?signin  → sign-in form     ?signup  → sign-up form
//   ?invite=CODE → one-time invite link (stripped, stored in sessionStorage)
//   (nothing) → public landing page

type AuthView = { show: boolean; mode: "signin" | "signup" };

function getAuthView(): AuthView {
  const params = new URLSearchParams(window.location.search);
  if (params.has("signup")) return { show: true, mode: "signup" };
  if (params.has("signin")) return { show: true, mode: "signin" };
  return { show: false, mode: "signin" };
}

function readAndStripInvite(): { inviteCode: string | null } {
  const params = new URLSearchParams(window.location.search);
  const inviteCode = params.get("invite");
  if (inviteCode) {
    sessionStorage.setItem("jigs:pendingInvite", inviteCode);
    history.replaceState({}, "", window.location.pathname + window.location.hash);
  }
  return { inviteCode };
}

function App() {
  const { t } = useTranslation();
  const [authState, setAuthState] = useState<AuthState>("loading");
  const [authError, setAuthError] = useState("");
  const [route, setRoute] = useState(parseHash);
  const { page } = route;
  const [inviteBanner, setInviteBanner] = useState<string | null>(null);
  const [authView, setAuthView] = useState<AuthView>(getAuthView);
  const [contactOpen, setContactOpen] = useState(false);

  // Read URL params once on mount — must run before auth check so the invite
  // code lands in sessionStorage before the user flow proceeds.
  const [inviteParams] = useState(readAndStripInvite);

  // Check auth on mount
  useEffect(() => {
    (async () => {
      const state = await loadAuthConfig();
      switch (state.mode) {
        case "local":
          // API explicitly returned auth: null → local dev, skip auth
          setAuthState("authenticated");
          break;
        case "configured": {
          // Cognito configured — validate session (checks expiry + refreshes if needed)
          const token = await getIdToken();
          setAuthState(token ? "authenticated" : "unauthenticated");
          break;
        }
        case "error":
          // Config fetch failed — fail closed, do NOT grant access
          setAuthError(state.message);
          setAuthState("error");
          break;
      }
    })();
  }, []);

  // Hash routing
  useEffect(() => {
    const onHashChange = () => setRoute(parseHash());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  // Sync authView with browser back/forward (?signin / ?signup in URL)
  useEffect(() => {
    const onPopState = () => setAuthView(getAuthView());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  // Clicking a top-nav item while already on that page is a no-op so
  // it doesn't clobber any `#templates/foo.md` sub-path the user has
  // accumulated by opening a file — the intuition is "clicking
  // Templates shouldn't lose your place if you're already there."
  // Genuine cross-page navigation still works normally.
  const navigate = useCallback(
    (p: Page) => {
      if (p === route.page) return;
      window.location.hash = p;
    },
    [route.page]
  );

  const handleGoToSignIn = useCallback(() => {
    history.pushState({}, "", "?signin");
    setAuthView({ show: true, mode: "signin" });
  }, []);

  const handleGoToSignUp = useCallback(() => {
    history.pushState({}, "", "?signup");
    setAuthView({ show: true, mode: "signup" });
  }, []);

  const handleSignedIn = useCallback(async () => {
    // Clean ?signin from URL after successful auth
    history.replaceState({}, "", window.location.pathname + window.location.hash);
    setAuthState("authenticated");
    // Check for a pending invite and show a banner if it's valid.
    const code = sessionStorage.getItem("jigs:pendingInvite");
    if (code) {
      sessionStorage.removeItem("jigs:pendingInvite");
      try {
        const result = await getInvite(code);
        if (result.valid) {
          setInviteBanner(t("auth.inviteBanner"));
        }
      } catch {
        // Non-critical — skip banner silently
      }
    }
  }, [t]);

  const handleSignOut = useCallback(() => {
    signOut();
    setAuthState("unauthenticated");
  }, []);

  if (authState === "loading") {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-50">
        <p className="text-gray-400 text-sm">{t("app.loading")}</p>
      </div>
    );
  }

  if (authState === "error") {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-50">
        <div className="text-center max-w-sm">
          <h1 className="text-lg font-bold text-gray-800 mb-2">{t("app.errorTitle")}</h1>
          <p className="text-gray-500 text-sm mb-4">
            {t("app.errorBody")}
          </p>
          <p className="text-gray-400 text-xs mb-4">{authError}</p>
          <button
            onClick={() => window.location.reload()}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 transition-colors"
          >
            {t("app.retry")}
          </button>
        </div>
      </div>
    );
  }

  if (authState === "unauthenticated") {
    const hasInvite = Boolean(inviteParams.inviteCode);
    if (!hasInvite && !authView.show) {
      return <LandingPage onSignIn={handleGoToSignIn} onSignUp={handleGoToSignUp} />;
    }
    return (
      <AuthScreen
        onSignedIn={handleSignedIn}
        initialMode={hasInvite || authView.mode === "signup" ? "signup" : "signin"}
        inviteCode={inviteParams.inviteCode ?? undefined}
      />
    );
  }

  // Path-based admin route — only reachable when authenticated.
  // Unauthenticated users hit the login page above, preventing the
  // 401 → signOut → reload → 401 loop.
  if (window.location.pathname === "/admin") {
    return <Admin />;
  }

  return (
    <div className="flex flex-col h-screen bg-gray-50">
      {/* Top header */}
      <header className="h-11 shrink-0 bg-white border-b border-gray-200 flex items-center px-4 gap-1">
        <NavItem
          label={t("nav.fillReport")}
          active={page === "fill"}
          onClick={() => navigate("fill")}
        />
        <NavItem
          label={t("nav.templates")}
          active={page === "templates"}
          onClick={() => navigate("templates")}
        />
        <NavItem
          label={t("nav.profile")}
          active={page === "profile"}
          onClick={() => navigate("profile")}
        />
        <div className="flex-1" />
        <button
          onClick={() => setContactOpen(true)}
          className="px-3 py-1.5 rounded-md text-sm text-gray-500 hover:bg-gray-100 transition-colors"
        >
          Contact
        </button>
        <button
          onClick={handleSignOut}
          className="px-3 py-1.5 rounded-md text-sm text-gray-500 hover:bg-gray-100 transition-colors"
        >
          {t("nav.signOut")}
        </button>
      </header>
      {contactOpen && (
        <ContactModal
          mode="authenticated"
          page={page}
          onClose={() => setContactOpen(false)}
        />
      )}

      {/* Invite bootstrap banner */}
      {inviteBanner && (
        <div className="bg-blue-50 border-b border-blue-200 px-4 py-2 flex items-center justify-between text-sm text-blue-700">
          <span>{inviteBanner}</span>
          <button
            onClick={() => setInviteBanner(null)}
            className="ml-4 text-blue-500 hover:text-blue-700"
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      )}

      {/* Main content */}
      <main className="flex-1 overflow-hidden">
        {page === "fill" && <Fill />}
        {page === "templates" && (
          <Templates initialPath={route.subpath || undefined} />
        )}
        {page === "profile" && <Profile />}
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Auth Screen — sign in, sign up, verify
// ---------------------------------------------------------------------------

type AuthMode = "signin" | "signup" | "verify";

function AuthScreen({
  onSignedIn,
  initialMode = "signin",
  inviteCode,
}: {
  onSignedIn: () => void;
  initialMode?: AuthMode;
  inviteCode?: string;
}) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<AuthMode>(initialMode);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSignIn = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await signIn(email, password);
      onSignedIn();
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : t("auth.signInFailed");
      if (msg.includes("User is not confirmed")) {
        setMode("verify");
        try { await resendCode(email); } catch { /* ignore */ }
      } else {
        setError(msg);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleSignUp = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await signUp(email, password, inviteCode);
      setMode("verify");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t("auth.signUpFailed"));
    } finally {
      setLoading(false);
    }
  };

  const handleVerify = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await confirmSignUp(email, code);
      // Auto sign-in after verification
      await signIn(email, password);
      onSignedIn();
    } catch (err: unknown) {
      setError(
        err instanceof Error ? err.message : t("auth.verifyFailed")
      );
    } finally {
      setLoading(false);
    }
  };

  const handleResend = async () => {
    setError("");
    try {
      await resendCode(email);
      setError(t("auth.codeResent"));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t("auth.resendFailed"));
    }
  };

  return (
    <div className="flex items-center justify-center h-screen bg-gray-50">
      <div className="w-full max-w-sm">
        <h1 className="text-3xl font-bold text-gray-800 mb-1 text-center">
          rellena.me
        </h1>
        <p className="text-gray-500 mb-8 text-center text-sm">
          {t("auth.tagline")}
        </p>

        {mode === "signin" && (
          <form onSubmit={handleSignIn} className="space-y-4">
            <input
              type="email"
              placeholder={t("auth.emailPlaceholder")}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
            <input
              type="password"
              placeholder={t("auth.passwordPlaceholder")}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
            {error && (
              <p className="text-red-600 text-xs">{error}</p>
            )}
            <button
              type="submit"
              disabled={loading}
              className="w-full py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors disabled:opacity-50"
            >
              {loading ? t("auth.signingIn") : t("auth.signIn")}
            </button>
            {initialMode === "signup" && (
              <p className="text-center text-xs text-gray-500">
                {t("auth.noAccount")}{" "}
                <button
                  type="button"
                  onClick={() => {
                    setMode("signup");
                    setError("");
                  }}
                  className="text-blue-600 hover:underline"
                >
                  {t("auth.signUp")}
                </button>
              </p>
            )}
          </form>
        )}

        {mode === "signup" && (
          <form onSubmit={handleSignUp} className="space-y-4">
            <input
              type="email"
              placeholder={t("auth.emailPlaceholder")}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
            <input
              type="password"
              placeholder={t("auth.passwordHint")}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
            {error && (
              <p className="text-red-600 text-xs">{error}</p>
            )}
            <button
              type="submit"
              disabled={loading}
              className="w-full py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors disabled:opacity-50"
            >
              {loading ? t("auth.creatingAccount") : t("auth.signUp")}
            </button>
            <p className="text-center text-xs text-gray-500">
              {t("auth.hasAccount")}{" "}
              <button
                type="button"
                onClick={() => {
                  setMode("signin");
                  setError("");
                }}
                className="text-blue-600 hover:underline"
              >
                {t("auth.signIn")}
              </button>
            </p>
          </form>
        )}

        {mode === "verify" && (
          <form onSubmit={handleVerify} className="space-y-4">
            <p className="text-sm text-gray-600 text-center">
              {t("auth.verifyPrompt")}{" "}
              <span className="font-medium">{email}</span>
            </p>
            <input
              type="text"
              placeholder={t("auth.codePlaceholder")}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
              autoFocus
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm text-center tracking-widest focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
            {error && (
              <p className={`text-xs ${error === t("auth.codeResent") ? "text-green-600" : "text-red-600"}`}>
                {error}
              </p>
            )}
            <button
              type="submit"
              disabled={loading}
              className="w-full py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors disabled:opacity-50"
            >
              {loading ? t("auth.verifying") : t("auth.verify")}
            </button>
            <p className="text-center text-xs text-gray-500">
              <button
                type="button"
                onClick={handleResend}
                className="text-blue-600 hover:underline"
              >
                {t("auth.resendCode")}
              </button>
              {" · "}
              <button
                type="button"
                onClick={() => {
                  setMode("signin");
                  setError("");
                }}
                className="text-blue-600 hover:underline"
              >
                {t("auth.backToSignIn")}
              </button>
            </p>
          </form>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// NavItem
// ---------------------------------------------------------------------------

function NavItem({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1.5 rounded-md text-sm transition-colors ${
        active
          ? "bg-blue-50 text-blue-700 font-medium"
          : "text-gray-600 hover:bg-gray-100"
      }`}
    >
      {label}
    </button>
  );
}

export default App;
