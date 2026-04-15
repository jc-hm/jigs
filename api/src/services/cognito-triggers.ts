import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { getInvite, getUserByCognitoId, autoProvisionUser } from "../db/entities.js";

const lambdaClient = new LambdaClient({});

/**
 * Handle the Cognito PostConfirmation_ConfirmSignUp trigger.
 *
 * Called synchronously by Cognito after a user confirms their email.
 * Must return within Cognito's 5-second trigger timeout, so no S3 work
 * is done here — the template copy is fired as an async Lambda self-invocation.
 *
 * Fully fault-tolerant: any error is logged and swallowed so Cognito always
 * marks the user as confirmed, even if the invite bootstrap fails.
 */
export async function handlePostConfirmation(
  event: Record<string, unknown>,
): Promise<void> {
  try {
    const attrs = (
      event.request as Record<string, Record<string, string>>
    ).userAttributes;

    const cognitoSub = attrs.sub;
    const email = attrs.email;
    const inviteCode = attrs["custom:invite_code"];

    if (!inviteCode) return;

    const invite = await getInvite(inviteCode);
    if (!invite || !invite.shareTemplates) return;

    // Provision the user now so we have a toUserId for the bootstrap.
    // If the trigger fires twice (Cognito retry), getUserByCognitoId guards
    // against re-provisioning and we skip the bootstrap on subsequent calls.
    let user = await getUserByCognitoId(cognitoSub);
    if (user) return; // already handled on a prior trigger invocation

    user = await autoProvisionUser(cognitoSub, email);

    // Async self-invoke for the S3 copy — returns immediately (<5ms).
    await lambdaClient.send(
      new InvokeCommand({
        FunctionName: process.env.AWS_LAMBDA_FUNCTION_NAME!,
        InvocationType: "Event",
        Payload: Buffer.from(
          JSON.stringify({
            type: "bootstrap",
            fromUserId: invite.fromUserId,
            toUserId: user.id,
          }),
        ),
      }),
    );
  } catch (err) {
    // Swallow — user must always be confirmed even if invite bootstrap fails.
    console.error("[cognito-trigger] post-confirmation error:", err);
  }
}
