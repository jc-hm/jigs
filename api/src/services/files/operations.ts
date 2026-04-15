import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { config } from "../../env.js";
import type { FileEntry } from "./types.js";

const AUTHOR_FILE = "AUTHOR.md";

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

/** Build the full S3 key from a userId and relative path. */
function toKey(userId: string, relativePath: string): string {
  const clean = relativePath.replace(/^\/+/, "");
  return `${userId}/templates/${clean}`;
}

/**
 * List files and folders at a given directory level.
 * Path is relative to {userId}/templates/. Pass "" or "/" for root.
 */
export async function ls(
  userId: string,
  path?: string
): Promise<FileEntry[]> {
  const prefix = toKey(userId, path || "") + (path && !path.endsWith("/") ? "/" : "");
  // Normalize: ensure prefix ends with /
  const normalizedPrefix = prefix.endsWith("/") ? prefix : prefix + "/";

  const res = await s3.send(
    new ListObjectsV2Command({
      Bucket: config.templateBucket,
      Prefix: normalizedPrefix,
      Delimiter: "/",
    })
  );

  const entries: FileEntry[] = [];

  // Folders (common prefixes)
  for (const cp of res.CommonPrefixes || []) {
    if (cp.Prefix) {
      const relative = cp.Prefix.slice(normalizedPrefix.length).replace(
        /\/$/,
        ""
      );
      if (relative) {
        entries.push({ path: relative, isDirectory: true });
      }
    }
  }

  // Files
  for (const obj of res.Contents || []) {
    if (!obj.Key) continue;
    const relative = obj.Key.slice(normalizedPrefix.length);
    // Skip the prefix itself (empty relative) and folder markers
    if (!relative || relative.endsWith("/")) continue;
    entries.push({ path: relative, isDirectory: false });
  }

  return entries.sort((a, b) => {
    // Directories first, then alphabetical
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.path.localeCompare(b.path);
  });
}

/**
 * List all file paths recursively under {userId}/templates/.
 * Returns relative paths (e.g., "mri-knee", "neuro/brain-mri").
 */
export async function lsRecursive(userId: string): Promise<string[]> {
  const prefix = `${userId}/templates/`;
  const paths: string[] = [];
  let continuationToken: string | undefined;

  do {
    const res = await s3.send(
      new ListObjectsV2Command({
        Bucket: config.templateBucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      })
    );

    for (const obj of res.Contents || []) {
      if (!obj.Key) continue;
      const relative = obj.Key.slice(prefix.length);
      // Skip empty and folder markers
      if (!relative || relative.endsWith("/")) continue;
      paths.push(relative);
    }

    continuationToken = res.NextContinuationToken;
  } while (continuationToken);

  return paths.sort();
}

/** Read a file's content. Path is relative to {userId}/templates/. */
export async function cat(userId: string, path: string): Promise<string> {
  const res = await s3.send(
    new GetObjectCommand({
      Bucket: config.templateBucket,
      Key: toKey(userId, path),
    })
  );
  return (await res.Body?.transformToString()) || "";
}

/** Create or update a file. Path is relative to {userId}/templates/. */
export async function write(
  userId: string,
  path: string,
  content: string
): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: config.templateBucket,
      Key: toKey(userId, path),
      Body: content,
      ContentType: "text/plain",
    })
  );
}

/** Delete a file. Path is relative to {userId}/templates/. */
export async function rm(userId: string, path: string): Promise<void> {
  await s3.send(
    new DeleteObjectCommand({
      Bucket: config.templateBucket,
      Key: toKey(userId, path),
    })
  );
}

/** Move/rename a file. Paths are relative to {userId}/templates/. */
export async function mv(
  userId: string,
  from: string,
  to: string
): Promise<void> {
  const bucket = config.templateBucket;
  const sourceKey = toKey(userId, from);
  const destKey = toKey(userId, to);

  await s3.send(
    new CopyObjectCommand({
      Bucket: bucket,
      CopySource: `${bucket}/${sourceKey}`,
      Key: destKey,
    })
  );

  await s3.send(
    new DeleteObjectCommand({
      Bucket: bucket,
      Key: sourceKey,
    })
  );
}

/** Create an empty folder marker. Path is relative to {userId}/templates/. */
export async function mkdir(userId: string, path: string): Promise<void> {
  const clean = path.replace(/\/+$/, "");
  await s3.send(
    new PutObjectCommand({
      Bucket: config.templateBucket,
      Key: toKey(userId, clean) + "/",
      Body: "",
      ContentType: "application/x-directory",
    })
  );
}

/**
 * Copy all template files from one user's prefix to another.
 * Used during invite-based onboarding to bootstrap new users with the
 * inviter's templates. Same-bucket CopyObject — server-side, no data egress.
 * Returns the number of objects copied.
 */
export async function copyUserTemplates(
  fromUserId: string,
  toUserId: string,
): Promise<number> {
  const bucket = config.templateBucket;
  const srcPrefix = `${fromUserId}/templates/`;
  let count = 0;
  let continuationToken: string | undefined;

  do {
    const res = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: srcPrefix,
        ContinuationToken: continuationToken,
      })
    );

    for (const obj of res.Contents || []) {
      if (!obj.Key) continue;
      const relPath = obj.Key.slice(srcPrefix.length);
      if (!relPath) continue;
      await s3.send(
        new CopyObjectCommand({
          Bucket: bucket,
          CopySource: `${bucket}/${obj.Key}`,
          Key: `${toUserId}/templates/${relPath}`,
        })
      );
      count++;
    }

    continuationToken = res.NextContinuationToken;
  } while (continuationToken);

  return count;
}

/**
 * Walk up the folder hierarchy from a template's location to find the
 * nearest AUTHOR.md. Returns its content, or undefined if none found.
 *
 * For template "neuro/brain-mri", checks:
 *   1. neuro/AUTHOR.md
 *   2. AUTHOR.md (root)
 */
export async function findAuthor(
  userId: string,
  templatePath: string
): Promise<string | undefined> {
  const parts = templatePath.split("/");
  // Remove the filename, leaving directory segments
  parts.pop();

  // Check from deepest directory up to root
  const dirsToCheck = [...parts];
  // Add root level
  const candidates: string[] = [];
  while (dirsToCheck.length > 0) {
    candidates.push([...dirsToCheck, AUTHOR_FILE].join("/"));
    dirsToCheck.pop();
  }
  candidates.push(AUTHOR_FILE); // root AUTHOR.md

  for (const candidatePath of candidates) {
    try {
      const content = await cat(userId, candidatePath);
      return content;
    } catch {
      // Not found, try next level up
    }
  }

  return undefined;
}
