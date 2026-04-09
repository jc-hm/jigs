import { useState, useEffect, useCallback } from "react";
import type { FormEvent } from "react";
import { Fill } from "./pages/Fill";
import { Templates } from "./pages/Templates";
import { Profile } from "./pages/Profile";
import {
  loadAuthConfig,
  getIdToken,
  signIn,
  signUp,
  confirmSignUp,
  resendCode,
  signOut,
} from "./lib/auth";

type Page = "fill" | "templates" | "profile";
type AuthState = "loading" | "authenticated" | "unauthenticated" | "error";

const VALID_PAGES: Page[] = ["fill", "templates", "profile"];

function getPageFromHash(): Page {
  const hash = window.location.hash.replace("#", "");
  return VALID_PAGES.includes(hash as Page) ? (hash as Page) : "fill";
}

function App() {
  const [authState, setAuthState] = useState<AuthState>("loading");
  const [authError, setAuthError] = useState("");
  const [page, setPage] = useState<Page>(getPageFromHash);

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
    const onHashChange = () => setPage(getPageFromHash());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const navigate = useCallback((p: Page) => {
    window.location.hash = p;
  }, []);

  const handleSignedIn = useCallback(() => {
    setAuthState("authenticated");
  }, []);

  const handleSignOut = useCallback(() => {
    signOut();
    setAuthState("unauthenticated");
  }, []);

  if (authState === "loading") {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-50">
        <p className="text-gray-400 text-sm">Loading...</p>
      </div>
    );
  }

  if (authState === "error") {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-50">
        <div className="text-center max-w-sm">
          <h1 className="text-lg font-bold text-gray-800 mb-2">Unable to load</h1>
          <p className="text-gray-500 text-sm mb-4">
            Could not connect to the server. Please try again later.
          </p>
          <p className="text-gray-400 text-xs mb-4">{authError}</p>
          <button
            onClick={() => window.location.reload()}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 transition-colors"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (authState === "unauthenticated") {
    return <AuthScreen onSignedIn={handleSignedIn} />;
  }

  return (
    <div className="flex h-screen bg-gray-50">
      {/* Sidebar */}
      <nav className="w-56 bg-white border-r border-gray-200 flex flex-col">
        <div className="p-4 border-b border-gray-200">
          <h1 className="text-lg font-bold text-gray-800">Jigs</h1>
        </div>
        <div className="flex-1 p-2 space-y-1">
          <NavItem
            label="Fill Report"
            active={page === "fill"}
            onClick={() => navigate("fill")}
          />
          <NavItem
            label="Templates"
            active={page === "templates"}
            onClick={() => navigate("templates")}
          />
          <NavItem
            label="Profile"
            active={page === "profile"}
            onClick={() => navigate("profile")}
          />
        </div>
        <div className="p-2 border-t border-gray-200">
          <button
            onClick={handleSignOut}
            className="w-full text-left px-3 py-2 rounded-lg text-sm text-gray-500 hover:bg-gray-100 transition-colors"
          >
            Sign out
          </button>
        </div>
      </nav>

      {/* Main content */}
      <main className="flex-1 overflow-hidden">
        {page === "fill" && <Fill />}
        {page === "templates" && <Templates />}
        {page === "profile" && <Profile />}
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Auth Screen — sign in, sign up, verify
// ---------------------------------------------------------------------------

type AuthMode = "signin" | "signup" | "verify";

function AuthScreen({ onSignedIn }: { onSignedIn: () => void }) {
  const [mode, setMode] = useState<AuthMode>("signin");
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
        err instanceof Error ? err.message : "Sign in failed";
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
      await signUp(email, password);
      setMode("verify");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Sign up failed");
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
        err instanceof Error ? err.message : "Verification failed"
      );
    } finally {
      setLoading(false);
    }
  };

  const handleResend = async () => {
    setError("");
    try {
      await resendCode(email);
      setError("Code resent — check your email.");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Resend failed");
    }
  };

  return (
    <div className="flex items-center justify-center h-screen bg-gray-50">
      <div className="w-full max-w-sm">
        <h1 className="text-3xl font-bold text-gray-800 mb-1 text-center">
          Jigs
        </h1>
        <p className="text-gray-500 mb-8 text-center text-sm">
          AI-powered template filling
        </p>

        {mode === "signin" && (
          <form onSubmit={handleSignIn} className="space-y-4">
            <input
              type="email"
              placeholder="Email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
            <input
              type="password"
              placeholder="Password"
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
              {loading ? "Signing in..." : "Sign in"}
            </button>
            <p className="text-center text-xs text-gray-500">
              Don&apos;t have an account?{" "}
              <button
                type="button"
                onClick={() => {
                  setMode("signup");
                  setError("");
                }}
                className="text-blue-600 hover:underline"
              >
                Sign up
              </button>
            </p>
          </form>
        )}

        {mode === "signup" && (
          <form onSubmit={handleSignUp} className="space-y-4">
            <input
              type="email"
              placeholder="Email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
            <input
              type="password"
              placeholder="Password (min 8 chars, 1 digit)"
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
              {loading ? "Creating account..." : "Sign up"}
            </button>
            <p className="text-center text-xs text-gray-500">
              Already have an account?{" "}
              <button
                type="button"
                onClick={() => {
                  setMode("signin");
                  setError("");
                }}
                className="text-blue-600 hover:underline"
              >
                Sign in
              </button>
            </p>
          </form>
        )}

        {mode === "verify" && (
          <form onSubmit={handleVerify} className="space-y-4">
            <p className="text-sm text-gray-600 text-center">
              Enter the verification code sent to{" "}
              <span className="font-medium">{email}</span>
            </p>
            <input
              type="text"
              placeholder="Verification code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
              autoFocus
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm text-center tracking-widest focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
            {error && (
              <p className={`text-xs ${error.includes("resent") ? "text-green-600" : "text-red-600"}`}>
                {error}
              </p>
            )}
            <button
              type="submit"
              disabled={loading}
              className="w-full py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors disabled:opacity-50"
            >
              {loading ? "Verifying..." : "Verify"}
            </button>
            <p className="text-center text-xs text-gray-500">
              <button
                type="button"
                onClick={handleResend}
                className="text-blue-600 hover:underline"
              >
                Resend code
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
                Back to sign in
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
      className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors ${
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
