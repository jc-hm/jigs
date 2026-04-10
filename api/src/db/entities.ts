import {
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { db, TABLE_NAME } from "./client.js";

// --- Types ---

export interface Org {
  id: string;
  name: string;
  region: string;
  plan: string;
  stripeCustomerId?: string;
}

export interface User {
  id: string;
  orgId: string;
  email: string;
  role: "admin" | "user";
  cognitoId: string;
}

// --- Org ---

export async function getOrg(orgId: string): Promise<Org | undefined> {
  const res = await db.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: `ORG#${orgId}`, SK: "METADATA" },
    })
  );
  if (!res.Item) return undefined;
  return {
    id: orgId,
    name: res.Item.name,
    region: res.Item.region,
    plan: res.Item.plan,
    stripeCustomerId: res.Item.stripeCustomerId,
  };
}

export async function putOrg(org: Org): Promise<void> {
  await db.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: `ORG#${org.id}`,
        SK: "METADATA",
        name: org.name,
        region: org.region,
        plan: org.plan,
        stripeCustomerId: org.stripeCustomerId,
      },
    })
  );
}

// --- User ---

export async function getUserByCognitoId(
  cognitoId: string
): Promise<User | undefined> {
  const res = await db.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: "GSI1",
      KeyConditionExpression: "GSI1PK = :pk AND GSI1SK = :sk",
      ExpressionAttributeValues: {
        ":pk": `COGNITO#${cognitoId}`,
        ":sk": "METADATA",
      },
    })
  );
  const item = res.Items?.[0];
  if (!item) return undefined;
  return {
    id: item.SK.replace("USER#", ""),
    orgId: item.PK.replace("ORG#", ""),
    email: item.email,
    role: item.role,
    cognitoId,
  };
}

export async function putUser(user: User): Promise<void> {
  await db.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: `ORG#${user.orgId}`,
        SK: `USER#${user.id}`,
        GSI1PK: `COGNITO#${user.cognitoId}`,
        GSI1SK: "METADATA",
        email: user.email,
        role: user.role,
        cognitoId: user.cognitoId,
      },
    })
  );
}

/** Auto-provision a new user + org on first sign-in. */
export async function autoProvisionUser(
  cognitoId: string,
  email: string
): Promise<User> {
  const userId = crypto.randomUUID().slice(0, 12);
  const orgId = crypto.randomUUID().slice(0, 12);

  await putOrg({
    id: orgId,
    name: email.split("@")[0],
    region: "us-west-2",
    plan: "free",
  });

  const user: User = {
    id: userId,
    orgId,
    email,
    role: "admin",
    cognitoId,
  };
  await putUser(user);
  return user;
}

// --- Usage ---

export type UsageAction = "router" | "fill" | "refine" | "agent_round";

/**
 * Increment per-call usage counters for a single AI call.
 *
 * Updates user-monthly, org-monthly, and (for fill/refine) the user-daily
 * counter used by the legacy free-tier limit. `reportCount` only increments
 * for fill/refine so existing free-tier semantics are preserved; router and
 * agent_round contribute to cost and token totals but not to reportCount.
 */
export async function incrementUsageCounters(
  userId: string,
  orgId: string,
  args: {
    action: UsageAction;
    costUsd: number;
    inputTokens: number;
    outputTokens: number;
  }
): Promise<void> {
  const now = new Date();
  const monthKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const dayKey = now.toISOString().slice(0, 10);
  const ttl = Math.floor(now.getTime() / 1000) + 48 * 3600;

  const isReport = args.action === "fill" || args.action === "refine";
  const callField =
    args.action === "router"
      ? "routerCalls"
      : args.action === "agent_round"
        ? "agentRounds"
        : "fillerCalls";

  // Build the monthly UpdateExpression. ADD handles missing attributes by
  // initializing to 0 first, so this works for the first call of the period.
  const monthlyUpdate = isReport
    ? "ADD reportCount :one, totalCostUsd :cost, inputTokens :in, outputTokens :out, #call :one"
    : "ADD totalCostUsd :cost, inputTokens :in, outputTokens :out, #call :one";

  const monthlyValues: Record<string, number> = {
    ":cost": args.costUsd,
    ":in": args.inputTokens,
    ":out": args.outputTokens,
    ":one": 1,
  };

  const writes: Promise<unknown>[] = [
    // User monthly
    db.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: `USER#${userId}`, SK: `USAGE#${monthKey}` },
        UpdateExpression: monthlyUpdate,
        ExpressionAttributeNames: { "#call": callField },
        ExpressionAttributeValues: monthlyValues,
      })
    ),
    // Org monthly
    db.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: `ORG#${orgId}`, SK: `USAGE#${monthKey}` },
        UpdateExpression: monthlyUpdate,
        ExpressionAttributeNames: { "#call": callField },
        ExpressionAttributeValues: monthlyValues,
      })
    ),
  ];

  // Daily counter only for report-producing calls (preserves free-tier limit).
  if (isReport) {
    writes.push(
      db.send(
        new UpdateCommand({
          TableName: TABLE_NAME,
          Key: { PK: `USER#${userId}`, SK: `DAILY#${dayKey}` },
          UpdateExpression: "ADD reportCount :one SET #ttl = :ttl",
          ExpressionAttributeNames: { "#ttl": "TTL" },
          ExpressionAttributeValues: { ":one": 1, ":ttl": ttl },
        })
      )
    );
  }

  await Promise.all(writes);
}

export async function getDailyUsage(userId: string): Promise<number> {
  const dayKey = new Date().toISOString().slice(0, 10);
  const res = await db.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: `USER#${userId}`, SK: `DAILY#${dayKey}` },
    })
  );
  return res.Item?.reportCount ?? 0;
}

export interface MonthlyUsage {
  reportCount: number;
  totalCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  routerCalls: number;
  fillerCalls: number;
  agentRounds: number;
}

export async function getMonthlyUsage(pk: string): Promise<MonthlyUsage> {
  const now = new Date();
  const monthKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const res = await db.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: pk, SK: `USAGE#${monthKey}` },
    })
  );
  return {
    reportCount: res.Item?.reportCount ?? 0,
    totalCostUsd: res.Item?.totalCostUsd ?? 0,
    inputTokens: res.Item?.inputTokens ?? 0,
    outputTokens: res.Item?.outputTokens ?? 0,
    routerCalls: res.Item?.routerCalls ?? 0,
    fillerCalls: res.Item?.fillerCalls ?? 0,
    agentRounds: res.Item?.agentRounds ?? 0,
  };
}

// --- Org balance (prepaid credits) ---

export interface OrgBalance {
  balanceUsd: number;
  topUpsUsd: number;
  spentUsd: number;
}

export async function getOrgBalance(orgId: string): Promise<OrgBalance> {
  const res = await db.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: `ORG#${orgId}`, SK: "BALANCE" },
    })
  );
  return {
    balanceUsd: res.Item?.balanceUsd ?? 0,
    topUpsUsd: res.Item?.topUpsUsd ?? 0,
    spentUsd: res.Item?.spentUsd ?? 0,
  };
}

/**
 * Credit the org's balance. Atomic ADD; creates the item if missing.
 * Use for: manual topups, signup grants, eventually Stripe webhook.
 */
export async function addBalance(orgId: string, amountUsd: number): Promise<void> {
  if (amountUsd <= 0) throw new Error("addBalance amount must be positive");
  await db.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: `ORG#${orgId}`, SK: "BALANCE" },
      UpdateExpression: "ADD balanceUsd :amt, topUpsUsd :amt",
      ExpressionAttributeValues: { ":amt": amountUsd },
    })
  );
}

/**
 * Debit the org's balance after a successful Bedrock call. Atomic ADD with
 * a negative value, plus a positive `spentUsd` accumulator. Allowed to drift
 * slightly negative (one call's worth) since the pre-call check is only
 * `balance > 0`.
 */
export async function deductBalance(orgId: string, amountUsd: number): Promise<void> {
  if (amountUsd < 0) throw new Error("deductBalance amount must be non-negative");
  if (amountUsd === 0) return;
  await db.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: `ORG#${orgId}`, SK: "BALANCE" },
      UpdateExpression: "ADD balanceUsd :neg, spentUsd :pos",
      ExpressionAttributeValues: { ":neg": -amountUsd, ":pos": amountUsd },
    })
  );
}
