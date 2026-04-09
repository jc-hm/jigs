import { Context, Next } from "hono";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import { config } from "../env.js";

export interface AuthUser {
  userId: string;
  orgId: string;
  role: "admin" | "user";
  cognitoId?: string;
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
    c.set("user", {
      userId: "test-user",
      orgId: "test-org",
      role: "admin",
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
    const { getUserByCognitoId, autoProvisionUser } = await import(
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

    c.set("user", {
      userId: user.id,
      orgId: user.orgId,
      role: user.role,
      cognitoId,
    } satisfies AuthUser);
    return next();
  } catch {
    return c.json({ error: "Invalid token" }, 401);
  }
}
