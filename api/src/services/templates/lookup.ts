import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { config } from "../../env.js";

const s3 = new S3Client(
  config.isLocal
    ? {
        endpoint: "http://localhost:9000",
        region: "local",
        forcePathStyle: true,
        credentials: {
          accessKeyId: "minioadmin",
          secretAccessKey: "minioadmin",
        },
      }
    : {}
);

export async function getTemplateContent(
  orgId: string,
  userId: string,
  s3Key: string
): Promise<string> {
  const bucket = config.templateBucket;

  // Try user fork first
  try {
    const userKey = `${orgId}/users/${userId}/${s3Key}`;
    const res = await s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: userKey })
    );
    return (await res.Body?.transformToString()) || "";
  } catch {
    // Fall back to org default
  }

  const orgKey = `${orgId}/${s3Key}`;
  const res = await s3.send(
    new GetObjectCommand({ Bucket: bucket, Key: orgKey })
  );
  return (await res.Body?.transformToString()) || "";
}

export async function putTemplateContent(
  orgId: string,
  s3Key: string,
  content: string
): Promise<void> {
  const bucket = config.templateBucket;
  const key = `${orgId}/${s3Key}`;
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: content,
      ContentType: "text/markdown",
    })
  );
}

export async function forkTemplate(
  orgId: string,
  userId: string,
  s3Key: string,
  content: string
): Promise<void> {
  const bucket = config.templateBucket;
  const key = `${orgId}/users/${userId}/${s3Key}`;
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: content,
      ContentType: "text/markdown",
    })
  );
}
