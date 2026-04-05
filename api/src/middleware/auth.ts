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
      tokenUse: "access",
      clientId: config.cognitoClientId,
    });
  }
  return verifier;
}

export async function authMiddleware(c: Context, next: Next) {
  // Local dev: skip auth, use test user
  if (config.isLocal) {
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
    // Look up user from DynamoDB by Cognito sub
    const { getUserByCognitoId } = await import("../db/entities.js");
    const user = await getUserByCognitoId(payload.sub);
    if (!user) {
      return c.json({ error: "User not found" }, 403);
    }
    c.set("user", {
      userId: user.id,
      orgId: user.orgId,
      role: user.role,
      cognitoId: payload.sub,
    } satisfies AuthUser);
    return next();
  } catch {
    return c.json({ error: "Invalid token" }, 401);
  }
}
