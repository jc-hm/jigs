import { serve } from "@hono/node-server";
import { app } from "./app.js";

const port = 3000;
console.log(`Jigs API running at http://localhost:${port}`);
serve({ fetch: app.fetch, port });
