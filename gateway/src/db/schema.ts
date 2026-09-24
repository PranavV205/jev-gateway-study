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
  // The user message could not be screened but was let through (fail policy "allow").
  flagged: integer("flagged", { mode: "boolean" }).notNull().default(false),
  classifier: text("classifier").notNull().default("none"),
  router: text("router").notNull().default("none"),
  routeReason: text("route_reason"),
  tier: text("tier", { enum: ["cheap", "strong"] }),
  provider: text("provider"),
  model: text("model"),
  // Total cost: screening plus the model call.
  costUsd: real("cost_usd").notNull(),
  screenCostUsd: real("screen_cost_usd").notNull().default(0),
  routeCostUsd: real("route_cost_usd").notNull().default(0),
  // What the model call would have cost on the strong tier, with no screening.
  baselineCostUsd: real("baseline_cost_usd").notNull(),
  latencyMs: integer("latency_ms").notNull(),
  screenLatencyMs: integer("screen_latency_ms").notNull().default(0),
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
  // Order within the request, starting at 1.
  attempt: integer("attempt").notNull().default(1),
  kind: text("kind", { enum: ["primary", "retry", "fallback", "escalation"] })
    .notNull()
    .default("primary"),
  tier: text("tier", { enum: ["cheap", "strong"] }),
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

// One row per screened text: the user message or one chunk.
export const screenResults = sqliteTable("screen_results", {
  id: text("id").primaryKey(),
  requestId: text("request_id")
    .notNull()
    .references(() => requests.id),
  target: text("target").notNull(), // "user" or the chunk id
  classifier: text("classifier").notNull(),
  model: text("model"),
  pInjection: real("p_injection"),
  pExfil: real("p_exfil"),
  action: text("action", { enum: ["allowed", "refused", "kept", "dropped"] }).notNull(),
  reason: text("reason"),
  inputTokens: integer("input_tokens").notNull(),
  costUsd: real("cost_usd").notNull(),
  latencyMs: integer("latency_ms").notNull(),
  status: text("status", { enum: ["ok", "error"] }).notNull(),
  error: text("error"),
  rawJson: text("raw_json"),
});

// One row per routing call.
export const routeDecisions = sqliteTable("route_decisions", {
  id: text("id").primaryKey(),
  requestId: text("request_id")
    .notNull()
    .references(() => requests.id),
  router: text("router").notNull(),
  model: text("model"),
  taskType: text("task_type"),
  taskProbsJson: text("task_probs_json"),
  confidence: real("confidence"),
  pNeedsStrong: real("p_needs_strong"),
  tier: text("tier", { enum: ["cheap", "strong"] }).notNull(),
  reason: text("reason").notNull(),
  inputTokens: integer("input_tokens").notNull(),
  costUsd: real("cost_usd").notNull(),
  latencyMs: integer("latency_ms").notNull(),
  status: text("status", { enum: ["ok", "error"] }).notNull(),
  error: text("error"),
});
