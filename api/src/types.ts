import type { AuthUser } from "./middleware/auth.js";

export type AppEnv = {
  Variables: {
    user: AuthUser;
    /**
     * Per-request UUID set by the requestId middleware in app.ts. Available
     * on every route (including public ones) and on every log line via
     * `c.get("requestId")`. Used to correlate Hono request logs, structured
     * application logs, and Bedrock cost records.
     */
    requestId: string;
  };
};
