// ---------------------------------------------------------------------------
// Auth module — Cognito email/password with SRP
// ---------------------------------------------------------------------------

import {
  CognitoUserPool,
  CognitoUser,
  AuthenticationDetails,
  CognitoUserSession,
  CognitoUserAttribute,
} from "amazon-cognito-identity-js";

export interface AuthConfig {
  userPoolId: string;
  clientId: string;
  region: string;
}

// ---------------------------------------------------------------------------
// Config — fetched once from /api/config
// ---------------------------------------------------------------------------

// Three states: "local" (auth disabled), "configured" (Cognito ready), "error" (fetch failed)
type ConfigState =
  | { mode: "local" }
  | { mode: "configured"; config: AuthConfig }
  | { mode: "error"; message: string };

let configState: ConfigState | null = null;

export async function loadAuthConfig(): Promise<ConfigState> {
  if (configState) return configState;
  try {
    const res = await fetch("/api/config");
    if (!res.ok) {
      configState = { mode: "error", message: `Config fetch failed: ${res.status}` };
      return configState;
    }
    const data = await res.json();
    if (data.auth === null) {
      // API explicitly returned auth: null → local dev mode (STAGE=local only)
      configState = { mode: "local" };
    } else if (data.auth?.userPoolId) {
      configState = { mode: "configured", config: data.auth };
    } else {
      // Unexpected response shape (e.g. Lambda error body) → fail closed, no access granted
      configState = {
        mode: "error",
        message: `Unexpected config response: ${JSON.stringify(data).slice(0, 120)}`,
      };
    }
  } catch (err) {
    configState = { mode: "error", message: `Config fetch failed: ${err}` };
  }
  return configState;
}

export function getAuthConfig(): AuthConfig | null {
  if (configState?.mode === "configured") return configState.config;
  return null;
}

// ---------------------------------------------------------------------------
// User pool
// ---------------------------------------------------------------------------

let pool: CognitoUserPool | null = null;

function getUserPool(): CognitoUserPool | null {
  if (pool) return pool;
  const cfg = getAuthConfig();
  if (!cfg) return null;
  pool = new CognitoUserPool({
    UserPoolId: cfg.userPoolId,
    ClientId: cfg.clientId,
  });
  return pool;
}

// ---------------------------------------------------------------------------
// Sign up
// ---------------------------------------------------------------------------

export function signUp(
  email: string,
  password: string,
  inviteCode?: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const userPool = getUserPool();
    if (!userPool) return reject(new Error("Auth not configured"));

    const attrs = [
      new CognitoUserAttribute({ Name: "email", Value: email }),
      ...(inviteCode
        ? [new CognitoUserAttribute({ Name: "custom:invite_code", Value: inviteCode })]
        : []),
    ];

    userPool.signUp(email, password, attrs, [], (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// Confirm sign up (verification code)
// ---------------------------------------------------------------------------

export function confirmSignUp(
  email: string,
  code: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const userPool = getUserPool();
    if (!userPool) return reject(new Error("Auth not configured"));

    const user = new CognitoUser({ Username: email, Pool: userPool });
    user.confirmRegistration(code, true, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// Resend verification code
// ---------------------------------------------------------------------------

export function resendCode(email: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const userPool = getUserPool();
    if (!userPool) return reject(new Error("Auth not configured"));

    const user = new CognitoUser({ Username: email, Pool: userPool });
    user.resendConfirmationCode((err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// Sign in (SRP)
// ---------------------------------------------------------------------------

export function signIn(
  email: string,
  password: string
): Promise<CognitoUserSession> {
  return new Promise((resolve, reject) => {
    const userPool = getUserPool();
    if (!userPool) return reject(new Error("Auth not configured"));

    const user = new CognitoUser({ Username: email, Pool: userPool });
    const authDetails = new AuthenticationDetails({
      Username: email,
      Password: password,
    });

    user.authenticateUser(authDetails, {
      onSuccess: (session) => resolve(session),
      onFailure: (err) => reject(err),
    });
  });
}

// ---------------------------------------------------------------------------
// Get current session / ID token
// ---------------------------------------------------------------------------

export function getIdToken(): Promise<string | null> {
  return new Promise((resolve) => {
    const userPool = getUserPool();
    if (!userPool) return resolve(null);

    const user = userPool.getCurrentUser();
    if (!user) return resolve(null);

    user.getSession(
      (err: Error | null, session: CognitoUserSession | null) => {
        if (err || !session?.isValid()) return resolve(null);
        resolve(session.getIdToken().getJwtToken());
      }
    );
  });
}

// ---------------------------------------------------------------------------
// Auth state check
// ---------------------------------------------------------------------------

export function hasStoredTokens(): boolean {
  const userPool = getUserPool();
  if (!userPool) return false;
  return !!userPool.getCurrentUser();
}

// ---------------------------------------------------------------------------
// Current user ID (for OPFS isolation)
// ---------------------------------------------------------------------------

/** Returns a stable user identifier for local storage isolation.
 *  In authenticated mode: Cognito `sub` (UUID) from the ID token.
 *  In local mode: "local". */
export function getCurrentUserId(): string {
  const userPool = getUserPool();
  if (!userPool) return "local";
  const user = userPool.getCurrentUser();
  if (!user) return "local";
  // Decode JWT payload (no verification needed — already verified by getSession)
  const token = user.getSignInUserSession()?.getIdToken().getJwtToken();
  if (!token) return "local";
  try {
    const payload = JSON.parse(atob(token.split(".")[1]));
    return payload.sub || "local";
  } catch {
    return "local";
  }
}

// ---------------------------------------------------------------------------
// Sign out
// ---------------------------------------------------------------------------

export function signOut() {
  const userPool = getUserPool();
  if (!userPool) return;
  const user = userPool.getCurrentUser();
  if (user) user.signOut();
}
