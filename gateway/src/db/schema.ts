import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

// One row per call to POST /v1/chat.
export const requests = sqliteTable("requests", {
  id: text("id").primaryKey(),
  createdAt: text("created_at").notNull(),
  appId: text("app_id").notNull(),
  // Hash, not text: user messages are not stored by default.
  userMessageHash: text("user_message_hash").notNull(),
  chunkCount: integer("chunk_count").notNull(),
  action: text("action", { enum: ["allowed", "refused", "error"] }).notNull(),
  tier: text("tier", { enum: ["cheap", "strong"] }),
  provider: text("provider"),
  model: text("model"),
  costUsd: real("cost_usd").notNull(),
  baselineCostUsd: real("baseline_cost_usd").notNull(),
  latencyMs: integer("latency_ms").notNull(),
  configVersion: text("config_version").notNull(),
  error: text("error"),
});

// One row per call to an LLM provider. A request can have more than one after retries or fallbacks.
export const llmCalls = sqliteTable("llm_calls", {
  id: text("id").primaryKey(),
  requestId: text("request_id")
    .notNull()
    .references(() => requests.id),
  createdAt: text("created_at").notNull(),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  inputTokens: integer("input_tokens").notNull(),
  outputTokens: integer("output_tokens").notNull(),
  reasoningTokens: integer("reasoning_tokens").notNull(),
  costUsd: real("cost_usd").notNull(),
  latencyMs: integer("latency_ms").notNull(),
  status: text("status", { enum: ["ok", "error"] }).notNull(),
  error: text("error"),
});
