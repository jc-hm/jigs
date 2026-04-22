import { Sentry } from "./lib/sentry.js";
import { Hono } from "hono";
import { streamHandle } from "hono/aws-lambda";
import type { LambdaContext, LambdaEvent } from "hono/aws-lambda";

// The Lambda Function URL uses RESPONSE_STREAM invoke mode, so the runtime
// calls the handler as:  handler(event, responseStream, context)
// and the exported handler must carry the StreamingMode.RESPONSE_STREAM symbol.
//
// STREAMING SYMBOL SIDE-EFFECT: once the symbol is set, Lambda's runtime
// treats ALL invocations as streaming — including Cognito PostConfirmation
// triggers. For streaming handlers, return values are silently ignored
// ("Streaming handlers ignore return values"). This means `return ev` (which
// Cognito requires as an echo of the event) never reaches Cognito, causing a
// reliable 5-second timeout on every sign-up confirmation.
//
// Fix: for trigger invocations, write the response to the responseStream and
// close it. The Lambda runtime buffers the stream content and forwards it to
// the synchronous caller (Cognito) as the invocation result.
//
// Cold-start note: loading app.ts statically pulls in all routes, services,
// and AWS clients even for Cognito trigger invocations, which adds ~1s of
// unnecessary init. We lazy-load app.ts so trigger cold starts only pay for
// cognito-triggers.ts + entities.ts — a much smaller dependency tree.
const STREAM_SYM = Symbol.for("aws.lambda.runtime.handler.streaming");
// Extract the symbol value from a minimal shim so we don't have to hardcode
// the enum number. new Hono() with no routes is essentially free.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const STREAM_SYM_VALUE = (streamHandle(new Hono()) as any)[STREAM_SYM];

// Lazily initialized on the first HTTP invocation.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _honoHandler: ((...args: any[]) => Promise<unknown>) | null = null;

async function getHonoHandler() {
  if (!_honoHandler) {
    const { app } = await import("./app.js");
    _honoHandler = streamHandle(app) as (...args: any[]) => Promise<unknown>; // eslint-disable-line @typescript-eslint/no-explicit-any
  }
  return _honoHandler;
}

// Write JSON to the response stream and close it. Used for trigger invocations
// where Lambda ignores return values but does forward stream content to the caller.
function writeStreamResponse(responseStream: unknown, body: unknown): void {
  const rs = responseStream as { write(d: string): void; end(d?: string): void };
  rs.end(JSON.stringify(body));
}

async function routingHandler(
  event: LambdaEvent | Record<string, unknown>,
  // Always a ResponseStream for streaming handlers — Lambda passes it even for
  // non-streaming callers like Cognito triggers. NOT the LambdaContext.
  responseStream: unknown,
  context: LambdaContext | undefined,
): Promise<unknown> {
  const ev = event as Record<string, unknown>;

  // Cognito Post-Confirmation trigger.
  // Write the echoed event to the stream (return value is ignored for streaming handlers).
  if (ev.triggerSource === "PostConfirmation_ConfirmSignUp") {
    const { handlePostConfirmation } = await import(
      "./services/cognito-triggers.js"
    );
    await handlePostConfirmation(ev);
    writeStreamResponse(responseStream, ev);
    await Sentry.flush(2000);
    return;
  }

  // Async bootstrap job — S3 template copy fired by the Cognito trigger.
  if (ev.type === "bootstrap") {
    const { runBootstrap } = await import("./services/bootstrap.js");
    await runBootstrap(ev.fromUserId as string, ev.toUserId as string);
    writeStreamResponse(responseStream, { ok: true });
    await Sentry.flush(2000);
    return;
  }

  // Normal HTTP handling — load the full Hono app on first invocation.
  const handler = await getHonoHandler();
  await handler(event, responseStream, context);
  await Sentry.flush(2000);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(routingHandler as any)[STREAM_SYM] = STREAM_SYM_VALUE;

export const handler = routingHandler;
