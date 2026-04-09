import { streamHandle } from "hono/aws-lambda";
import { app } from "./app.js";

export const handler = streamHandle(app);
