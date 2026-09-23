import { drizzle } from "drizzle-orm/d1";
import { config, costUsd, type Tier, tierModel } from "./config";
import { llmCalls, requests } from "./db/schema";
import { buildMessages } from "./prompt";
import { type ChatResult, chat, ProviderError } from "./providers/chat";
import type { ChatRequest } from "./schemas";

export interface GatewayReport {
  request_id: string;
  action: "allowed" | "refused" | "error";
  dropped_chunks: string[];
  tier: Tier | null;
  provider: string | null;
  model: string | null;
  route: null;
  screen: null;
  cost_usd: number;
  baseline_cost_usd: number;
  latency_ms: { model: number; total: number };
  error?: string;
}

export interface ChatResponse {
  answer: string | null;
  gateway: GatewayReport;
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function apiKeyFor(env: Env, provider: string): string {
  const key = provider === "groq" ? env.GROQ_API_KEY : env.OPENROUTER_API_KEY;
  if (!key) throw new Error(`Missing API key for provider ${provider}`);
  return key;
}

// Screening and routing are not wired in yet: every request goes to the strong tier
// unless the caller forces a tier.
export async function handleChat(env: Env, req: ChatRequest): Promise<ChatResponse> {
  const start = Date.now();
  const requestId = crypto.randomUUID();
  const tier: Tier = req.options.force_tier ?? "strong";
  const { provider, model } = tierModel(tier);
  const strong = tierModel("strong");

  let result: ChatResult | null = null;
  let error: ProviderError | Error | null = null;

  if (!req.options.dry_run) {
    try {
      result = await chat(
        provider,
        apiKeyFor(env, provider),
        model,
        buildMessages(req.user_message, req.context_chunks, req.system_prompt),
      );
    } catch (err) {
      error = err instanceof Error ? err : new Error(String(err));
    }
  }

  const cost = result ? costUsd(model, result.inputTokens, result.outputTokens) : 0;
  // What the same tokens would have cost on the strong tier. Output length would differ
  // on another model, so this is an estimate.
  const baselineCost = result ? costUsd(strong.model, result.inputTokens, result.outputTokens) : 0;
  const action = error ? "error" : "allowed";
  const totalMs = Date.now() - start;
  const createdAt = new Date().toISOString();

  const db = drizzle(env.DB);
  await db.insert(requests).values({
    id: requestId,
    createdAt,
    appId: req.app_id,
    userMessageHash: await sha256(req.user_message),
    chunkCount: req.context_chunks.length,
    action,
    tier,
    provider,
    model,
    costUsd: cost,
    baselineCostUsd: baselineCost,
    latencyMs: totalMs,
    configVersion: config.version,
    error: error?.message ?? null,
  });

  if (result || error) {
    await db.insert(llmCalls).values({
      id: crypto.randomUUID(),
      requestId,
      createdAt,
      provider,
      model,
      inputTokens: result?.inputTokens ?? 0,
      outputTokens: result?.outputTokens ?? 0,
      reasoningTokens: result?.reasoningTokens ?? 0,
      costUsd: cost,
      latencyMs: result?.latencyMs ?? (error instanceof ProviderError ? error.latencyMs : 0),
      status: error ? "error" : "ok",
      error: error?.message ?? null,
    });
  }

  return {
    answer: result?.content ?? null,
    gateway: {
      request_id: requestId,
      action,
      dropped_chunks: [],
      tier,
      provider,
      model,
      route: null,
      screen: null,
      cost_usd: cost,
      baseline_cost_usd: baselineCost,
      latency_ms: { model: result?.latencyMs ?? 0, total: totalMs },
      ...(error ? { error: error.message } : {}),
    },
  };
}
