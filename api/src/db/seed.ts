import {
  CreateTableCommand,
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import { putOrg, putUser, putSkill } from "./entities.js";

const client = new DynamoDBClient({
  endpoint: "http://localhost:8000",
  region: "local",
});

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

async function seed() {
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

  await putSkill({
    id: "radiology",
    orgId: "test-org",
    name: "Radiology Report Generator",
    tone: "Professional medical reporting, concise, structured",
    instructions:
      "You are a radiology report generator. Fill the template using the clinical information provided. For findings not mentioned by the user, use standard normal values. Output only the completed report, no explanations.",
    taxonomy: [
      {
        id: "mri-knee",
        name: "MRI Knee",
        modality: "MRI",
        bodyPart: "knee",
        description: "Standard knee MRI including ACL, meniscus, cartilage, effusion evaluation",
        s3Key: "templates/mri-knee.md",
      },
      {
        id: "ct-chest",
        name: "CT Chest",
        modality: "CT",
        bodyPart: "chest",
        description: "Chest CT with or without contrast, lung parenchyma and mediastinum",
        s3Key: "templates/ct-chest.md",
      },
      {
        id: "xray-lumbar",
        name: "X-Ray Lumbar Spine",
        modality: "X-Ray",
        bodyPart: "lumbar spine",
        description: "AP and lateral views of the lumbar spine",
        s3Key: "templates/xray-lumbar.md",
      },
    ],
  });

  console.log("Seed data inserted");
}

seed().catch(console.error);
