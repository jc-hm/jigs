import {
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { db, TABLE_NAME } from "./client.js";

// --- Types ---

export interface Invite {
  code: string;
  fromUserId: string;
  expiresAt: string;
  shareTemplates: boolean;
}

// --- Org / User types ---

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
  lastLoginAt?: string;
  loggedOutAt?: string;
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
    lastLoginAt: item.lastLoginAt as string | undefined,
    loggedOutAt: item.loggedOutAt as string | undefined,
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

// New orgs receive this much free credit on signup so they can use the
// product without wiring Stripe first. Retire / lower once payments are
// live and the free-tier daily counter is removed.
const STARTER_CREDIT_USD = 10;

/**
 * Auto-provision a new user + org on first sign-in.
 *
 * Uses conditional DynamoDB writes with retry to *guarantee* unique IDs:
 * each PutCommand fails fast on `ConditionalCheckFailedException` if the
 * generated ID already exists, and we regenerate. With 50 bits of entropy
 * the loop almost never iterates, but it's the only correct way to ensure
 * uniqueness rather than relying on probability.
 *
 * After the org + user rows land, the new org is credited with
 * STARTER_CREDIT_USD so the balance gate (`assertBalance`) will pass on
 * their very first Bedrock call. If the credit write fails we log and
 * continue — provisioning the user is more important than the grant, and
 * a support topup can fix the grant later.
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

  // Best-effort starter credit. Imported locally to avoid a forward-reference
  // headache — addBalance is defined further down in this same file.
  try {
    await addBalance(orgId, STARTER_CREDIT_USD);
  } catch {
    // Swallow: the user still exists and can be topped up manually.
    // TODO: structured log once the api/src/lib/log helper is importable here.
  }

  return {
    id: userId,
    orgId,
    email,
    role: "admin",
    cognitoId,
  };
}


// --- Org balance (prepaid credits) ---

// The BALANCE record doubles as the "org-lifetime stats" row: balance +
// lifetime topups + lifetime spend + lifetime report count. These are all
// cheap counters updated via atomic ADD, so the single-item design keeps
// reads to one GET.
export interface OrgBalance {
  balanceUsd: number;
  topUpsUsd: number;
  spentUsd: number;
  reportsLifetime: number;
  // Lifetime token counters by model tier (li = lite/haiku, md = medium/sonnet)
  liIn: number;
  liOut: number;
  mdIn: number;
  mdOut: number;
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
    reportsLifetime: res.Item?.reportsLifetime ?? 0,
    liIn: res.Item?.liIn ?? 0,
    liOut: res.Item?.liOut ?? 0,
    mdIn: res.Item?.mdIn ?? 0,
    mdOut: res.Item?.mdOut ?? 0,
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
 * a negative value on `balanceUsd`, a positive value on `spentUsd`, and an
 * optional `reportsLifetime` bump so the BALANCE row also tracks "total
 * reports produced by this org" as a lifetime counter (used by the Profile
 * page). `reportDelta` is expected to be 0 for router/agent_round calls
 * and 1 for fill/refine, but the signature stays numeric in case a single
 * call ever represents multiple reports.
 *
 * The balance is allowed to drift slightly negative (one call's worth)
 * since the pre-call check is only `balance > 0`.
 */
export interface TokenDelta {
  tier: "li" | "md";
  in: number;
  out: number;
}

export async function deductBalance(
  orgId: string,
  amountUsd: number,
  reportDelta: number = 0,
  tokens?: TokenDelta,
): Promise<void> {
  if (amountUsd < 0) throw new Error("deductBalance amount must be non-negative");
  if (amountUsd === 0 && reportDelta === 0 && !tokens) return;

  let updateExpr = "ADD balanceUsd :neg, spentUsd :pos, reportsLifetime :rep";
  const exprValues: Record<string, number> = {
    ":neg": -amountUsd,
    ":pos": amountUsd,
    ":rep": reportDelta,
  };

  if (tokens) {
    const inField = `${tokens.tier}In`;
    const outField = `${tokens.tier}Out`;
    updateExpr += `, ${inField} :tokIn, ${outField} :tokOut`;
    exprValues[":tokIn"] = tokens.in;
    exprValues[":tokOut"] = tokens.out;
  }

  await db.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: `ORG#${orgId}`, SK: "BALANCE" },
      UpdateExpression: updateExpr,
      ExpressionAttributeValues: exprValues,
    })
  );
}

// --- Invites ---

/**
 * Create a time-limited invite code tied to the inviting user's templates.
 * DynamoDB TTL auto-expires the record after `ttlDays` days; the in-code
 * check in `getInvite` provides an eager guard before TTL cleanup runs.
 */
export async function createInvite(
  fromUserId: string,
  shareTemplates: boolean,
  ttlDays = 7,
): Promise<{ code: string; expiresAt: string }> {
  const code = generateShortId();
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);
  const expiresAtIso = expiresAt.toISOString();
  const ttl = Math.floor(expiresAt.getTime() / 1000);

  await db.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: `INVITE#${code}`,
        SK: "METADATA",
        fromUserId,
        expiresAt: expiresAtIso,
        shareTemplates,
        TTL: ttl,
      },
      ConditionExpression: "attribute_not_exists(PK)",
    })
  );

  return { code, expiresAt: expiresAtIso };
}

export async function updateLastLogin(userId: string, orgId: string): Promise<void> {
  await db.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: `ORG#${orgId}`, SK: `USER#${userId}` },
      UpdateExpression: "SET lastLoginAt = :now",
      ExpressionAttributeValues: { ":now": new Date().toISOString() },
    })
  );
}

// Stamp a logout time on the user record so auth middleware can reject any
// token issued before this timestamp, giving true immediate revocation without
// needing a separate blocklist store. Works because we already do a DynamoDB
// read per request in getUserByCognitoId — the check is free.
export async function setLoggedOutAt(userId: string, orgId: string): Promise<void> {
  await db.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: `ORG#${orgId}`, SK: `USER#${userId}` },
      UpdateExpression: "SET loggedOutAt = :now",
      ExpressionAttributeValues: { ":now": new Date().toISOString() },
    })
  );
}

// --- Admin queries ---

export interface OrgSummary {
  orgId: string;
  name: string;
  plan: string;
  balance: OrgBalance;
}

export async function listAllOrgs(): Promise<OrgSummary[]> {
  // Scan for METADATA items (org + invite records share this SK).
  // Filter to ORG# prefix to exclude INVITE# items.
  const res = await db.send(
    new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: "SK = :meta AND begins_with(PK, :orgPrefix)",
      ExpressionAttributeValues: { ":meta": "METADATA", ":orgPrefix": "ORG#" },
      ProjectionExpression: "PK, #n, #p",
      ExpressionAttributeNames: { "#n": "name", "#p": "plan" },
    })
  );

  const items = res.Items ?? [];
  return Promise.all(
    items.map(async (item) => {
      const orgId = (item.PK as string).replace("ORG#", "");
      const balance = await getOrgBalance(orgId);
      return { orgId, name: item["name"] as string, plan: item["plan"] as string, balance };
    })
  );
}

export async function getUserById(orgId: string, userId: string): Promise<User | undefined> {
  const res = await db.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: `ORG#${orgId}`, SK: `USER#${userId}` },
    })
  );
  if (!res.Item) return undefined;
  return {
    id: userId,
    orgId,
    email: res.Item.email as string,
    role: res.Item.role as "admin" | "user",
    cognitoId: res.Item.cognitoId as string,
    lastLoginAt: res.Item.lastLoginAt as string | undefined,
  };
}

export async function getOrgUsers(orgId: string): Promise<User[]> {
  const res = await db.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
      ExpressionAttributeValues: {
        ":pk": `ORG#${orgId}`,
        ":prefix": "USER#",
      },
    })
  );
  return (res.Items ?? []).map((item) => ({
    id: (item.SK as string).replace("USER#", ""),
    orgId,
    email: item.email as string,
    role: item.role as "admin" | "user",
    cognitoId: item.cognitoId as string,
    lastLoginAt: item.lastLoginAt as string | undefined,
  }));
}

// Adjust an org's balance by a signed delta (positive = credit, negative = debit).
// Used for admin corrections — does not touch topUpsUsd or spentUsd counters.
export async function adjustBalance(orgId: string, deltaUsd: number): Promise<void> {
  if (deltaUsd === 0) return;
  await db.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: `ORG#${orgId}`, SK: "BALANCE" },
      UpdateExpression: "ADD balanceUsd :delta",
      ExpressionAttributeValues: { ":delta": deltaUsd },
    })
  );
}

// --- Generic rate limiter ---

/**
 * Atomically increment a counter keyed by `key` and return whether the caller
 * is within the allowed limit for the given window.
 *
 * The key is caller-constructed and can encode any criteria:
 *   `ip:${ip}:feedback`       IP-scoped per-action limit
 *   `user:${userId}:export`   per-user per-action limit
 *   `org:${orgId}:api`        per-org limit
 *   `email:${email}:waitlist` per-email idempotence gate
 *
 * Uses a single atomic UpdateItem (ADD + if_not_exists) so there is no
 * read-before-write race. DynamoDB TTL auto-deletes the item after the
 * window expires, resetting the counter for the next window.
 */
export async function checkRateLimit(
  key: string,
  limit: number,
  windowSecs: number,
): Promise<{ allowed: boolean; remaining: number }> {
  const expiry = Math.floor(Date.now() / 1000) + windowSecs;
  const res = await db.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: `RATELIMIT#${key}`, SK: `RATELIMIT#${key}` },
      UpdateExpression:
        "ADD #count :one SET #ttl = if_not_exists(#ttl, :expiry)",
      ExpressionAttributeNames: { "#count": "count", "#ttl": "TTL" },
      ExpressionAttributeValues: { ":one": 1, ":expiry": expiry },
      ReturnValues: "ALL_NEW",
    }),
  );
  const count = (res.Attributes?.count as number) ?? 1;
  return { allowed: count <= limit, remaining: Math.max(0, limit - count) };
}

// --- Feedback / contact ---

export type FeedbackType = "contact" | "reaction" | "bug";
export type FeedbackRating = "up" | "down";

export interface FeedbackContext {
  page?: string;
  requestId?: string;
  action?: string;
}

export interface FeedbackItem {
  id: string;
  type: FeedbackType;
  createdAt: string;
  content?: string;
  rating?: FeedbackRating;
  context?: FeedbackContext;
  userId?: string;
  orgId?: string;
  senderEmail?: string;
  senderName?: string;
  read?: boolean;
}

export async function putFeedback(item: FeedbackItem): Promise<void> {
  await db.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: `FEEDBACK#${item.id}`,
        SK: `FEEDBACK#${item.id}`,
        GSI2PK: "FEEDBACK",
        GSI2SK: item.createdAt,
        type: item.type,
        createdAt: item.createdAt,
        ...(item.content !== undefined && { content: item.content }),
        ...(item.rating !== undefined && { rating: item.rating }),
        ...(item.context !== undefined && { context: item.context }),
        ...(item.userId !== undefined && { userId: item.userId }),
        ...(item.orgId !== undefined && { orgId: item.orgId }),
        ...(item.senderEmail !== undefined && { senderEmail: item.senderEmail }),
        ...(item.senderName !== undefined && { senderName: item.senderName }),
        read: item.read ?? false,
      },
    }),
  );
}

function itemToFeedback(item: Record<string, unknown>): FeedbackItem {
  return {
    id: (item.PK as string).replace("FEEDBACK#", ""),
    type: item.type as FeedbackType,
    createdAt: item.createdAt as string,
    content: item.content as string | undefined,
    rating: item.rating as FeedbackRating | undefined,
    context: item.context as FeedbackContext | undefined,
    userId: item.userId as string | undefined,
    orgId: item.orgId as string | undefined,
    senderEmail: item.senderEmail as string | undefined,
    senderName: item.senderName as string | undefined,
    read: (item.read as boolean | undefined) ?? false,
  };
}

export async function listFeedback(
  limit: number = 20,
  cursor?: string,
): Promise<{ items: FeedbackItem[]; nextCursor?: string }> {
  const res = await db.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: "GSI2",
      KeyConditionExpression: "GSI2PK = :pk",
      ExpressionAttributeValues: { ":pk": "FEEDBACK" },
      ScanIndexForward: false,
      Limit: limit,
      ...(cursor && {
        ExclusiveStartKey: JSON.parse(
          Buffer.from(cursor, "base64url").toString(),
        ),
      }),
    }),
  );
  const items = (res.Items ?? []).map(itemToFeedback);
  const nextCursor = res.LastEvaluatedKey
    ? Buffer.from(JSON.stringify(res.LastEvaluatedKey)).toString("base64url")
    : undefined;
  return { items, nextCursor };
}

export async function markFeedbackRead(id: string): Promise<void> {
  await db.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: `FEEDBACK#${id}`, SK: `FEEDBACK#${id}` },
      UpdateExpression: "SET #read = :t",
      ExpressionAttributeNames: { "#read": "read" },
      ExpressionAttributeValues: { ":t": true },
    }),
  );
}

// --- Waitlist ---

export interface WaitlistEntry {
  email: string;
  createdAt: string;
  note?: string;
}

export async function putWaitlist(
  email: string,
  note?: string,
): Promise<void> {
  await db.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: `WAITLIST#${email.toLowerCase()}`,
        SK: "METADATA",
        email: email.toLowerCase(),
        createdAt: new Date().toISOString(),
        ...(note && { note }),
      },
      ConditionExpression: "attribute_not_exists(PK)",
    }),
  );
}

export async function listWaitlist(): Promise<WaitlistEntry[]> {
  const res = await db.send(
    new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: "begins_with(PK, :prefix) AND SK = :meta",
      ExpressionAttributeValues: { ":prefix": "WAITLIST#", ":meta": "METADATA" },
    }),
  );
  return (res.Items ?? [])
    .map((item) => ({
      email: item.email as string,
      createdAt: item.createdAt as string,
      note: item.note as string | undefined,
    }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Return the invite if it exists and has not expired; null otherwise. */
export async function getInvite(code: string): Promise<Invite | null> {
  const res = await db.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: `INVITE#${code}`, SK: "METADATA" },
    })
  );
  if (!res.Item) return null;
  // Eager expiry check — TTL cleanup can lag by up to 48 hours per AWS docs.
  if (new Date(res.Item.expiresAt) < new Date()) return null;
  return {
    code,
    fromUserId: res.Item.fromUserId,
    expiresAt: res.Item.expiresAt,
    shareTemplates: res.Item.shareTemplates,
  };
}
