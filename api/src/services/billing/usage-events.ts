import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { gzipSync } from "zlib";
import { config } from "../../env.js";
import { log } from "../../lib/log.js";
import type { ModelTier } from "./tracker.js";

export interface UsageEvent {
  ts: number;        // epoch ms UTC, start of Bedrock call
  req_id: string;
  org_id: string;
  user_id: string;
  model_id: string;  // exact Bedrock model ID
  model_tier: ModelTier;
  action: string;    // router | fill | refine | agent_round
  surface: string;   // fill | templates
  in_tok: number;
  out_tok: number;
  cost_usd: number;  // pre-spread Bedrock cost
  lat_ms: number;    // Bedrock call wall-clock latency
}

let s3: S3Client | null = null;
function getS3(): S3Client {
  if (!s3) s3 = new S3Client({});
  return s3;
}

/**
 * Fire-and-forget: serialises the event as gzipped NDJSON and puts it to S3
 * under a Hive-partitioned path ready for Athena consumption. Errors are
 * logged but never propagated — analytics loss is acceptable, blocking the
 * API response is not.
 *
 * Path: events/model_usage/org_id={orgId}/year={Y}/month={MM}/day={DD}/{reqId}.json.gz
 */
export function putUsageEvent(event: UsageEvent): void {
  if (!config.usageBucket) return;

  const d = new Date(event.ts);
  const year  = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day   = String(d.getUTCDate()).padStart(2, "0");

  const key = `events/model_usage/org_id=${event.org_id}/year=${year}/month=${month}/day=${day}/${event.req_id}.json.gz`;

  getS3()
    .send(
      new PutObjectCommand({
        Bucket: config.usageBucket,
        Key: key,
        Body: gzipSync(JSON.stringify(event)),
        ContentType: "application/json",
        ContentEncoding: "gzip",
      }),
    )
    .catch((err) =>
      log.error("usage.put_failed", err, { reqId: event.req_id, orgId: event.org_id }),
    );
}
