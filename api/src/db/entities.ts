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

export interface TemplateTaxonomyEntry {
  id: string;
  name: string;
  modality?: string;
  bodyPart?: string;
  description: string;
  s3Key: string;
}

export interface Skill {
  id: string;
  orgId: string;
  name: string;
  tone: string;
  instructions: string;
  taxonomy: TemplateTaxonomyEntry[];
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

// --- Skill ---

export async function getSkill(
  orgId: string,
  skillId: string
): Promise<Skill | undefined> {
  const res = await db.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: `ORG#${orgId}`, SK: `SKILL#${skillId}` },
    })
  );
  if (!res.Item) return undefined;
  return {
    id: skillId,
    orgId,
    name: res.Item.name,
    tone: res.Item.tone,
    instructions: res.Item.instructions,
    taxonomy: res.Item.taxonomy || [],
  };
}

export async function putSkill(skill: Skill): Promise<void> {
  await db.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        PK: `ORG#${skill.orgId}`,
        SK: `SKILL#${skill.id}`,
        name: skill.name,
        tone: skill.tone,
        instructions: skill.instructions,
        taxonomy: skill.taxonomy,
      },
    })
  );
}

export async function listSkills(orgId: string): Promise<Skill[]> {
  const res = await db.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
      ExpressionAttributeValues: {
        ":pk": `ORG#${orgId}`,
        ":sk": "SKILL#",
      },
    })
  );
  return (res.Items || []).map((item) => ({
    id: item.SK.replace("SKILL#", ""),
    orgId,
    name: item.name,
    tone: item.tone,
    instructions: item.instructions,
    taxonomy: item.taxonomy || [],
  }));
}

// --- Usage ---

export async function incrementUsage(
  userId: string,
  orgId: string,
  costUsd: number
): Promise<void> {
  const now = new Date();
  const monthKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const dayKey = now.toISOString().slice(0, 10);
  const ttl = Math.floor(now.getTime() / 1000) + 48 * 3600;

  // Increment all three counters in parallel
  await Promise.all([
    // User monthly
    db.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: `USER#${userId}`, SK: `USAGE#${monthKey}` },
        UpdateExpression:
          "ADD reportCount :one, totalCostUsd :cost",
        ExpressionAttributeValues: { ":one": 1, ":cost": costUsd },
      })
    ),
    // Org monthly
    db.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: `ORG#${orgId}`, SK: `USAGE#${monthKey}` },
        UpdateExpression:
          "ADD reportCount :one, totalCostUsd :cost",
        ExpressionAttributeValues: { ":one": 1, ":cost": costUsd },
      })
    ),
    // User daily (with TTL)
    db.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { PK: `USER#${userId}`, SK: `DAILY#${dayKey}` },
        UpdateExpression: "ADD reportCount :one SET #ttl = :ttl",
        ExpressionAttributeNames: { "#ttl": "TTL" },
        ExpressionAttributeValues: { ":one": 1, ":ttl": ttl },
      })
    ),
  ]);
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

export async function getMonthlyUsage(
  pk: string
): Promise<{ reportCount: number; totalCostUsd: number }> {
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
  };
}
