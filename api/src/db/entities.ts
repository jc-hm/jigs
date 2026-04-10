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

// Crockford base32 alphabet: digits + uppercase letters minus I, L, O, U.
// 32 symbols × 5 bits per char × 10 chars = 50 bits of entropy. At 50 bits,
// collision probability per generation is ~9 × 10⁻¹⁶ even with millions of
// existing IDs — combined with the conditional-write retry loop in
// `autoProvisionUser`, IDs are *guaranteed* unique, not just probabilistically.
// Uppercase-only avoids dictation/copy-paste ambiguity.
const SHORT_ID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const SHORT_ID_LENGTH = 10;

function generateShortId(): string {
  const bytes = new Uint8Array(SHORT_ID_LENGTH);
  crypto.getRandomValues(bytes);
  let id = "";
  for (let i = 0; i < SHORT_ID_LENGTH; i++) {
    // Mask to 5 bits (0-31) and index into the 32-char alphabet.
    id += SHORT_ID_ALPHABET[bytes[i] & 31];
  }
  return id;
}

/**
 * Auto-provision a new user + org on first sign-in.
 *
 * Uses conditional DynamoDB writes with retry to *guarantee* unique IDs:
 * each PutCommand fails fast on `ConditionalCheckFailedException` if the
 * generated ID already exists, and we regenerate. With 50 bits of entropy
 * the loop almost never iterates, but it's the only correct way to ensure
 * uniqueness rather than relying on probability.
 */
export async function autoProvisionUser(
  cognitoId: string,
  email: string
): Promise<User> {
  const MAX_ID_ATTEMPTS = 5;

  let orgId = "";
  for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt++) {
    const candidate = generateShortId();
    try {
      await db.send(
        new PutCommand({
          TableName: TABLE_NAME,
          Item: {
            PK: `ORG#${candidate}`,
            SK: "METADATA",
            name: email.split("@")[0],
            region: "us-west-2",
            plan: "free",
          },
          ConditionExpression: "attribute_not_exists(PK)",
        })
      );
      orgId = candidate;
      break;
    } catch (e: unknown) {
      if (e instanceof Error && e.name === "ConditionalCheckFailedException") {
        continue;
      }
      throw e;
    }
  }
  if (!orgId) {
    throw new Error(
      `autoProvisionUser: failed to allocate unique orgId after ${MAX_ID_ATTEMPTS} attempts`
    );
  }

  let userId = "";
  for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt++) {
    const candidate = generateShortId();
    try {
      await db.send(
        new PutCommand({
          TableName: TABLE_NAME,
          Item: {
            PK: `ORG#${orgId}`,
            SK: `USER#${candidate}`,
            GSI1PK: `COGNITO#${cognitoId}`,
            GSI1SK: "METADATA",
            email,
            role: "admin",
            cognitoId,
          },
          ConditionExpression: "attribute_not_exists(SK)",
        })
      );
      userId = candidate;
      break;
    } catch (e: unknown) {
      if (e instanceof Error && e.name === "ConditionalCheckFailedException") {
        continue;
      }
      throw e;
    }
  }
  if (!userId) {
    throw new Error(
      `autoProvisionUser: failed to allocate unique userId after ${MAX_ID_ATTEMPTS} attempts`
    );
  }

  return {
    id: userId,
    orgId,
    email,
    role: "admin",
    cognitoId,
  };
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
