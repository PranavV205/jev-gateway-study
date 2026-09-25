import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Set RUN_LIVE=1 (with keys in the environment) to also run tests that call real APIs.
const live = process.env.RUN_LIVE === "1";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            RUN_LIVE: live ? "1" : "0",
            ALLOWED_ORIGINS: "http://localhost:5173,http://localhost:5174",
            GROQ_API_KEY: live ? (process.env.GROQ_API_KEY ?? "") : "test-groq-key",
            TYPESAFE_API_KEY: live ? (process.env.TYPESAFE_API_KEY ?? "") : "test-typesafe-key",
            OPENROUTER_API_KEY: live ? (process.env.OPENROUTER_API_KEY ?? "") : "test-openrouter-key",
          },
        },
      }),
    ],
    test: { setupFiles: ["./test/apply-migrations.ts"] },
  };
});
