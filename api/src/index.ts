import { streamHandle } from "hono/aws-lambda";
import type { LambdaContext, LambdaEvent } from "hono/aws-lambda";
import { app } from "./app.js";

// The Lambda Function URL uses RESPONSE_STREAM invoke mode, so the runtime
// calls the handler as:  handler(event, responseStream, context)
// NOT the regular:       handler(event, context, callback)
//
// For Lambda to use the streaming protocol, the exported handler must carry
// Symbol.for("aws.lambda.runtime.handler.streaming") set to the runtime's
// StreamingMode.RESPONSE_STREAM enum value. Hono's streamHandle() sets this
// internally via awslambda.streamifyResponse(). Without the marker, Lambda
// uses regular invocation and passes LambdaContext as the second argument
// instead of a writable responseStream → "responseStream.end is not a function".
//
// Setting the symbol to `true` (instead of the enum value) triggers a
// validation path in the runtime that throws MalformedStreamingHandler.
// The correct approach: copy the exact symbol value Hono already set.
//
// Cognito Post-Confirmation triggers invoke the same Lambda function via
// regular (non-streaming) invocation. Lambda calls the handler with (event,
// context) only — no responseStream. We detect trigger events by shape and
// return before touching the stream arguments.
const honoStreamHandler = streamHandle(app);

const STREAM_SYM = Symbol.for("aws.lambda.runtime.handler.streaming");

async function routingHandler(
  event: LambdaEvent | Record<string, unknown>,
  // In streaming mode: ResponseStream. For Cognito triggers: LambdaContext.
  // Only forwarded to honoStreamHandler for HTTP events.
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

// Copy the StreamingMode.RESPONSE_STREAM marker from honoStreamHandler to our
// routing wrapper. This is the value set by awslambda.streamifyResponse() —
// it must be the exact enum value the runtime expects, not a plain boolean.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(routingHandler as any)[STREAM_SYM] = (honoStreamHandler as any)[STREAM_SYM];

export const handler = routingHandler;
