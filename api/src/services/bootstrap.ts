import { copyUserTemplates } from "./files/operations.js";

/**
 * Async template bootstrap job — invoked by the Cognito Post-Confirmation
 * trigger via Lambda self-invocation (InvocationType: "Event").
 *
 * Copies all files under {fromUserId}/templates/ to {toUserId}/templates/
 * using same-bucket S3 CopyObject (server-side, no data egress).
 */
export async function runBootstrap(
  fromUserId: string,
  toUserId: string,
): Promise<void> {
  const count = await copyUserTemplates(fromUserId, toUserId);
  console.log(
    `[bootstrap] copied ${count} template(s): ${fromUserId} → ${toUserId}`,
  );
}
