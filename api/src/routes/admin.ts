import { Hono } from "hono";
import {
  CognitoIdentityProviderClient,
  AdminUserGlobalSignOutCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import {
  listAllOrgs,
  getOrg,
  getOrgBalance,
  getOrgUsers,
  getUserById,
  addBalance,
  adjustBalance,
  setLoggedOutAt,
  listFeedback,
  markFeedbackRead,
  listWaitlist,
} from "../db/entities.js";
import { config } from "../env.js";
import { log } from "../lib/log.js";
import type { AppEnv } from "../types.js";

const admin = new Hono<AppEnv>();

const cognitoClient = new CognitoIdentityProviderClient({
  region: config.region,
});

admin.get("/overview", async (c) => {
  const user = c.get("user");
  const requestId = c.get("requestId");
  log.info("admin.overview", { requestId, userId: user.userId });

  const orgs = await listAllOrgs();
  const orgsWithUsers = await Promise.all(
    orgs.map(async (org) => {
      const users = await getOrgUsers(org.orgId);
      return { ...org, users };
    })
  );

  const aggregate = {
    orgCount: orgs.length,
    totalBalanceUsd: orgs.reduce((s, o) => s + o.balance.balanceUsd, 0),
    totalSpentUsd: orgs.reduce((s, o) => s + o.balance.spentUsd, 0),
  };

  return c.json({ orgs: orgsWithUsers, aggregate });
});

admin.post("/orgs/:orgId/topup", async (c) => {
  const user = c.get("user");
  const requestId = c.get("requestId");
  const orgId = c.req.param("orgId");

  const body = await c.req.json<{ amountUsd: number; reason?: string }>();
  const { amountUsd, reason } = body;

  if (typeof amountUsd !== "number" || amountUsd === 0 || Math.abs(amountUsd) > 1000) {
    return c.json({ error: "amountUsd must be a non-zero number between -1000 and 1000" }, 400);
  }

  const org = await getOrg(orgId);
  if (!org) return c.json({ error: "Org not found" }, 404);

  if (amountUsd > 0) {
    await addBalance(orgId, amountUsd);
  } else {
    await adjustBalance(orgId, amountUsd);
  }

  log.info("admin.topup", {
    requestId,
    userId: user.userId,
    targetOrgId: orgId,
    amountUsd,
    reason: reason ?? "(no reason given)",
  });

  const newBalance = await getOrgBalance(orgId);
  return c.json({ orgId, amountUsd, newBalance });
});

admin.post("/orgs/:orgId/users/:userId/logout", async (c) => {
  const user = c.get("user");
  const requestId = c.get("requestId");
  const orgId = c.req.param("orgId");
  const userId = c.req.param("userId");

  const target = await getUserById(orgId, userId);
  if (!target) return c.json({ error: "User not found" }, 404);

  await cognitoClient.send(
    new AdminUserGlobalSignOutCommand({
      UserPoolId: config.cognitoUserPoolId,
      Username: target.email,
    })
  );

  // Stamp loggedOutAt so the auth middleware rejects any existing ID token
  // issued before this timestamp — gives true immediate revocation without
  // waiting for the ~1hr ID token TTL to expire.
  await setLoggedOutAt(userId, orgId);

  log.info("admin.force_logout", {
    requestId,
    userId: user.userId,
    targetUserId: userId,
    targetEmail: target.email,
  });

  return c.json({ userId, loggedOut: true });
});

admin.get("/waitlist", async (c) => {
  const user = c.get("user");
  const requestId = c.get("requestId");
  log.info("admin.waitlist", { requestId, userId: user.userId });
  const entries = await listWaitlist();
  return c.json({ entries });
});

admin.get("/feedback", async (c) => {
  const user = c.get("user");
  const requestId = c.get("requestId");
  const limit = Math.min(parseInt(c.req.query("limit") ?? "20", 10), 100);
  const cursor = c.req.query("cursor") ?? undefined;
  log.info("admin.feedback", { requestId, userId: user.userId, limit });
  const result = await listFeedback(limit, cursor);
  return c.json(result);
});

admin.patch("/feedback/:id/read", async (c) => {
  const user = c.get("user");
  const requestId = c.get("requestId");
  const id = c.req.param("id");
  await markFeedbackRead(id);
  log.info("admin.feedback.read", { requestId, userId: user.userId, id });
  return c.json({ ok: true });
});

export { admin };
