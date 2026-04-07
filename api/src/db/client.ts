import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { config } from "../env.js";

const client = new DynamoDBClient(
  config.isLocal
    ? {
        endpoint: "http://localhost:8000",
        region: "local",
        credentials: { accessKeyId: "local", secretAccessKey: "local" },
      }
    : {}
);

export const db = DynamoDBDocumentClient.from(client, {
  marshallOptions: { removeUndefinedValues: true },
});

export const TABLE_NAME = config.tableName;
