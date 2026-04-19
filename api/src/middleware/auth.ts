import { Context, Next } from "hono";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import { config } from "../env.js";

export interface AuthUser {
  userId: string;
  orgId: string;
  role: "admin" | "user";
  cognitoId?: string;
  superAdmin?: boolean;
  email?: string;
}

// Cached verifier instance (JWKS cached across warm Lambda invocations)
let verifier: ReturnType<typeof CognitoJwtVerifier.create> | null = null;

function getVerifier() {
  if (!verifier) {
    verifier = CognitoJwtVerifier.create({
      userPoolId: config.cognitoUserPoolId,
      tokenUse: "id",
      clientId: config.cognitoClientId,
    });
  }
  return verifier;
}

export async function authMiddleware(c: Context, next: Next) {
  // Local dev: skip auth only if STAGE is explicitly "local" AND no Cognito is configured.
  // If a pool ID exists, always enforce auth — prevents misconfigured deploys from skipping.
  if (config.isLocal && !config.cognitoUserPoolId) {
    const localCognitoId = "local-admin-sub";
    c.set("user", {
      userId: "test-user",
      orgId: "test-org",
      role: "admin",
      cognitoId: localCognitoId,
      superAdmin: config.superAdminCognitoId
        ? localCognitoId === config.superAdminCognitoId
        : false,
    } satisfies AuthUser);
    return next();
  }

  const authHeader = c.req.header("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "Missing authorization header" }, 401);
  }

  const token = authHeader.slice(7);
  try {
    const payload = await getVerifier().verify(token);
    const cognitoId = payload.sub;
    const email = (payload as Record<string, unknown>).email as
      | string
      | undefined;

    // Look up user from DynamoDB by Cognito sub
    const { getUserByCognitoId, autoProvisionUser, updateLastLogin } = await import(
      "../db/entities.js"
    );
    let user = await getUserByCognitoId(cognitoId);

    // Auto-provision on first sign-in
    if (!user) {
      if (!email) {
        return c.json({ error: "Email not available in token" }, 403);
      }
      user = await autoProvisionUser(cognitoId, email);
    }

    // Reject tokens issued before a forced logout (loggedOutAt timestamp).
    // payload.iat is seconds since epoch; loggedOutAt is an ISO string.
    if (user.loggedOutAt && payload.iat * 1000 < new Date(user.loggedOutAt).getTime()) {
      return c.json({ error: "Session has been revoked" }, 401);
    }

    // Track last login — fire-and-forget, never blocks the request
    updateLastLogin(user.id, user.orgId).catch(() => {});

    c.set("user", {
      userId: user.id,
      orgId: user.orgId,
      role: user.role,
      cognitoId,
      superAdmin: config.superAdminCognitoId
        ? cognitoId === config.superAdminCognitoId
        : false,
      email: email ?? undefined,
    } satisfies AuthUser);
    return next();
  } catch {
    return c.json({ error: "Invalid token" }, 401);
  }
}
