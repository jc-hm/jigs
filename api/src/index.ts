import { streamHandle } from "hono/aws-lambda";
import type { LambdaContext, LambdaEvent } from "hono/aws-lambda";
import { app } from "./app.js";

// Handler type spelled out inline: LambdaContext and LambdaEvent are
// publicly exported from hono/aws-lambda, avoiding the TS2742 "cannot
// be named without a reference to a deep module path" error on export.
type LambdaCallback = (error?: Error | string | null, result?: unknown) => void;
export const handler: (
  event: LambdaEvent,
  context: LambdaContext,
  callback: LambdaCallback,
) => void | Promise<unknown> = streamHandle(app);
