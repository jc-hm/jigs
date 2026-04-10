import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.integration.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Force local-mode so the DynamoDB/S3 clients point at the Docker
    // containers. Without this, env.ts treats the run as deployed and the
    // SDK tries to hit real AWS, surfacing as ResourceNotFoundException on
    // the seed step.
    env: {
      STAGE: "local",
    },
  },
});
