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
export async function deductBalance(
  orgId: string,
  amountUsd: number,
  reportDelta: number = 0,
): Promise<void> {
  if (amountUsd < 0) throw new Error("deductBalance amount must be non-negative");
  if (amountUsd === 0 && reportDelta === 0) return;
  await db.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: `ORG#${orgId}`, SK: "BALANCE" },
      UpdateExpression:
        "ADD balanceUsd :neg, spentUsd :pos, reportsLifetime :rep",
      ExpressionAttributeValues: {
        ":neg": -amountUsd,
        ":pos": amountUsd,
        ":rep": reportDelta,
      },
    })
  );
}
