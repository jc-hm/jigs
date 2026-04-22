import * as Sentry from "@sentry/aws-serverless";

// No-ops when SENTRY_DSN is unset (local dev, CI).
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.STAGE || "local",
  enabled: !!process.env.SENTRY_DSN,
  // Disable performance tracing — we use CloudWatch for latency.
  tracesSampleRate: 0,
});

export { Sentry };
