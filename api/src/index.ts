import { streamHandle } from "hono/aws-lambda";
import type { LambdaContext, LambdaEvent } from "hono/aws-lambda";
import { app } from "./app.js";

// The Lambda Function URL uses RESPONSE_STREAM invoke mode, so the runtime
// calls the handler as:  handler(event, responseStream, context)
// NOT the regular:       handler(event, context, callback)
//
// For Lambda to use the streaming protocol, the exported handler must carry
// Symbol.for("aws.lambda.runtime.handler.streaming") = true — the same marker
// that awslambda.streamifyResponse (used internally by Hono's streamHandle)
// sets. Without this marker, Lambda uses regular invocation and passes the
// LambdaContext as the second argument instead of a writable responseStream,
// causing "responseStream.end is not a function".
//
// Cognito Post-Confirmation triggers invoke the same Lambda function via
// regular (non-streaming) invocation. In that case Lambda still calls our
// handler with (event, context) — no responseStream. We detect trigger events
// by shape and return before touching the stream arguments.
const honoStreamHandler = streamHandle(app);

async function routingHandler(
  event: LambdaEvent | Record<string, unknown>,
  // In streaming mode this is ResponseStream; for Cognito triggers it's LambdaContext.
  // We only pass it through to honoStreamHandler for HTTP events.
  responseStreamOrContext: unknown,
  contextOrUndefined: LambdaContext | undefined,
): Promise<unknown> {
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

  // Normal HTTP handling — pass streaming arguments through unchanged.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (honoStreamHandler as (...a: unknown[]) => Promise<unknown>)(
    event, responseStreamOrContext, contextOrUndefined,
  );
}

// Mark as streaming handler so Lambda provides responseStream as second arg.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
((routingHandler as any)[Symbol.for("aws.lambda.runtime.handler.streaming")] = true);

export const handler = routingHandler;
