import { streamHandle } from "hono/aws-lambda";
import type { LambdaContext, LambdaEvent } from "hono/aws-lambda";
import { app } from "./app.js";

// Handler type spelled out inline: LambdaContext and LambdaEvent are
// publicly exported from hono/aws-lambda, avoiding the TS2742 "cannot
// be named without a reference to a deep module path" error on export.
type LambdaCallback = (error?: Error | string | null, result?: unknown) => void;

export const handler = async (
  event: LambdaEvent | Record<string, unknown>,
  context: LambdaContext,
  callback: LambdaCallback,
): Promise<unknown> => {
  const ev = event as Record<string, unknown>;

  // Cognito Post-Confirmation trigger — provision user + fire async bootstrap.
  if (ev.triggerSource === "PostConfirmation_ConfirmSignUp") {
    const { handlePostConfirmation } = await import(
      "./services/cognito-triggers.js"
    );
    await handlePostConfirmation(ev);
    return ev; // Cognito requires the trigger to echo the event back
  }

  // Async bootstrap job — S3 template copy fired by the Cognito trigger.
  if (ev.type === "bootstrap") {
    const { runBootstrap } = await import("./services/bootstrap.js");
    await runBootstrap(ev.fromUserId as string, ev.toUserId as string);
    return { ok: true };
  }

  // Normal HTTP handling via Hono + streaming Lambda Function URL.
  return streamHandle(app)(event as LambdaEvent, context, callback);
};
