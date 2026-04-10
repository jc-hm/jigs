import {
  CreateTableCommand,
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import {
  CreateBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { addBalance, getOrgBalance, putOrg, putUser } from "./entities.js";

const client = new DynamoDBClient({
  endpoint: "http://localhost:8000",
  region: "local",
  credentials: { accessKeyId: "local", secretAccessKey: "local" },
});

const s3 = new S3Client({
  endpoint: "http://localhost:9000",
  region: "local",
  forcePathStyle: true,
  credentials: {
    accessKeyId: "minioadmin",
    secretAccessKey: "minioadmin",
  },
});

const BUCKET = "jigs-templates-local";
const __dirname = dirname(fileURLToPath(import.meta.url));

async function createTable() {
  try {
    await client.send(
      new CreateTableCommand({
        TableName: "jigs-local",
        KeySchema: [
          { AttributeName: "PK", KeyType: "HASH" },
          { AttributeName: "SK", KeyType: "RANGE" },
        ],
        AttributeDefinitions: [
          { AttributeName: "PK", AttributeType: "S" },
          { AttributeName: "SK", AttributeType: "S" },
          { AttributeName: "GSI1PK", AttributeType: "S" },
          { AttributeName: "GSI1SK", AttributeType: "S" },
        ],
        GlobalSecondaryIndexes: [
          {
            IndexName: "GSI1",
            KeySchema: [
              { AttributeName: "GSI1PK", KeyType: "HASH" },
              { AttributeName: "GSI1SK", KeyType: "RANGE" },
            ],
            Projection: { ProjectionType: "ALL" },
          },
        ],
        BillingMode: "PAY_PER_REQUEST",
      })
    );
    console.log("Table created");
  } catch (e: unknown) {
    if (e instanceof Error && e.name === "ResourceInUseException") {
      console.log("Table already exists");
    } else {
      throw e;
    }
  }
}

export async function seed() {
  await createTable();

  await putOrg({
    id: "test-org",
    name: "Test Radiology Group",
    region: "eu-central-1",
    plan: "free",
  });

  await putUser({
    id: "test-user",
    orgId: "test-org",
    email: "test@example.com",
    role: "admin",
    cognitoId: "test-cognito-id",
  });

  // Seed a starter balance so the local TrackedBedrock gate passes. Idempotent
  // top-ups would inflate the balance on every re-seed, so we only credit if
  // the balance is currently zero.
  const existing = await getOrgBalance("test-org");
  if (existing.balanceUsd <= 0) {
    await addBalance("test-org", 10);
    console.log("Seeded test-org with $10 starter balance");
  }

  // Create S3 bucket and upload templates
  try {
    await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
    console.log("S3 bucket created");
  } catch (e: unknown) {
    if (e instanceof Error && e.name === "BucketAlreadyOwnedByYou") {
      console.log("S3 bucket already exists");
    } else {
      throw e;
    }
  }

  const templatesDir = join(__dirname, "../../seed-templates");

  // Upload templates keyed by userId (test-user/templates/)
  const templateFiles = [
    { file: "mri-knee.md", key: "test-user/templates/mri-knee.md" },
    { file: "ct-chest.md", key: "test-user/templates/ct-chest.md" },
    { file: "xray-lumbar.md", key: "test-user/templates/xray-lumbar.md" },
  ];

  for (const t of templateFiles) {
    const content = readFileSync(join(templatesDir, t.file), "utf-8");
    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: t.key,
        Body: content,
        ContentType: "text/plain",
      })
    );
    console.log(`Uploaded ${t.key}`);
  }

  // Upload AUTHOR.md with fill instructions
  const authorContent = readFileSync(join(templatesDir, "AUTHOR.md"), "utf-8");
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: "test-user/templates/AUTHOR.md",
      Body: authorContent,
      ContentType: "text/plain",
    })
  );
  console.log("Uploaded test-user/templates/AUTHOR.md");

  console.log("Seed complete");
}

seed().catch(console.error);
