import * as Sentry from "@sentry/react";

// DSN is intentionally in source — browser DSNs are public by design
// (they appear in the JS bundle and Sentry uses inbound filters for abuse prevention).
const SENTRY_DSN =
  "https://69b42f4f1b805a644c2d1f42e3ccf3e2@o4511256560926720.ingest.de.sentry.io/4511256573116496";

Sentry.init({
  dsn: SENTRY_DSN,
  // "production" | "development" — Vite sets this based on build mode.
  environment: import.meta.env.MODE,
  // Only active in production builds so local dev stays noise-free.
  enabled: import.meta.env.PROD,
  tracesSampleRate: 0,
});

export { Sentry };
