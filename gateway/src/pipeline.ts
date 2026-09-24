import { drizzle } from "drizzle-orm/d1";
import type { Classifier } from "./classifiers/base";
import { JevClassifier } from "./classifiers/jev";
import { config, costUsd, type Tier, tierModel } from "./config";
import { llmCalls, requests, screenResults } from "./db/schema";
import { buildMessages } from "./prompt";
import { type ChatResult, chat, ProviderError } from "./providers/chat";
import type { ChatRequest } from "./schemas";
import { type ScreenRun, screen, screenReport } from "./screen";

export interface GatewayReport {
  request_id: string;
  action: "allowed" | "refused" | "error";
  dropped_chunks: string[];
  tier: Tier | null;
  provider: string | null;
  model: string | null;
  route: null;
  screen: ReturnType<typeof screenReport>;
  cost_usd: number;
  baseline_cost_usd: number;
  latency_ms: { screen: number; model: number; total: number };
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

export function makeClassifier(env: Env, name: ChatRequest["options"]["classifier"]): Classifier | null {
  return name === "jev" ? new JevClassifier(env.TYPESAFE_API_KEY) : null;
}

// Routing is not wired in yet: allowed requests go to the strong tier unless the caller forces one.
export async function handleChat(
  env: Env,
  req: ChatRequest,
  classifier: Classifier | null = makeClassifier(env, req.options.classifier),
): Promise<ChatResponse> {
  const start = Date.now();
  const requestId = crypto.randomUUID();

  const run = await screen(classifier, req.user_message, req.context_chunks);
  const refused = run.decision.action === "refused";
  const dropped = new Set(run.decision.chunks.filter((c) => c.action === "dropped").map((c) => c.id));
  const keptChunks = req.context_chunks.filter((c) => !dropped.has(c.id));

  const tier: Tier = req.options.force_tier ?? "strong";
  const { provider, model } = tierModel(tier);
  const strong = tierModel("strong");

  let result: ChatResult | null = null;
  let error: Error | null = null;

  if (!refused && !req.options.dry_run) {
    try {
      result = await chat(
        provider,
        apiKeyFor(env, provider),
        model,
        buildMessages(req.user_message, keptChunks, req.system_prompt),
      );
    } catch (err) {
      error = err instanceof Error ? err : new Error(String(err));
    }
  }

  const llmCost = result ? costUsd(model, result.inputTokens, result.outputTokens) : 0;
  // What the same tokens would have cost on the strong tier with no screening. Output length
  // would differ on another model, so this is an estimate.
  const baselineCost = result ? costUsd(strong.model, result.inputTokens, result.outputTokens) : 0;
  const action = refused ? "refused" : error ? "error" : "allowed";
  const calledModel = Boolean(result || error);
  const totalMs = Date.now() - start;

  await log(env, {
    requestId,
    req,
    run,
    action,
    tier: calledModel ? tier : null,
    provider: calledModel ? provider : null,
    model: calledModel ? model : null,
    llmCost,
    baselineCost,
    totalMs,
    result,
    error,
  });

  return {
    answer: result?.content ?? null,
    gateway: {
      request_id: requestId,
      action,
      dropped_chunks: [...dropped],
      tier: calledModel ? tier : null,
      provider: calledModel ? provider : null,
      model: calledModel ? model : null,
      route: null,
      screen: screenReport(run),
      cost_usd: llmCost + run.costUsd,
      baseline_cost_usd: baselineCost,
      latency_ms: { screen: run.latencyMs, model: result?.latencyMs ?? 0, total: totalMs },
      ...(error ? { error: error.message } : {}),
    },
  };
}

interface LogInput {
  requestId: string;
  req: ChatRequest;
  run: ScreenRun;
  action: GatewayReport["action"];
  tier: Tier | null;
  provider: string | null;
  model: string | null;
  llmCost: number;
  baselineCost: number;
  totalMs: number;
  result: ChatResult | null;
  error: Error | null;
}

async function log(env: Env, x: LogInput) {
  const db = drizzle(env.DB);
  const createdAt = new Date().toISOString();

  await db.insert(requests).values({
    id: x.requestId,
    createdAt,
    appId: x.req.app_id,
    userMessageHash: await sha256(x.req.user_message),
    chunkCount: x.req.context_chunks.length,
    action: x.action,
    flagged: x.run.decision.flagged,
    classifier: x.run.classifier,
    tier: x.tier,
    provider: x.provider,
    model: x.model,
    costUsd: x.llmCost + x.run.costUsd,
    screenCostUsd: x.run.costUsd,
    baselineCostUsd: x.baselineCost,
    latencyMs: x.totalMs,
    screenLatencyMs: x.run.latencyMs,
    configVersion: config.version,
    error: x.error?.message ?? null,
  });

  if (x.run.user) {
    const actions = new Map(x.run.decision.chunks.map((c) => [c.id, c]));
    const rows = [
      {
        target: "user",
        outcome: x.run.user,
        pExfil: null,
        action: x.run.decision.action,
        reason: x.run.decision.userReason,
      },
      ...x.run.chunks.map(({ id, outcome }) => ({
        target: id,
        outcome,
        pExfil: outcome.ok ? (outcome.score as { pExfil: number | null }).pExfil : null,
        action: actions.get(id)?.action ?? "kept",
        reason: actions.get(id)?.reason ?? null,
      })),
    ];
    // D1 limits bound parameters per statement, so insert one row at a time in a batch.
    const [first, ...rest] = rows.map((r) =>
      db.insert(screenResults).values({
        id: crypto.randomUUID(),
        requestId: x.requestId,
        target: r.target,
        classifier: x.run.classifier,
        model: r.outcome.ok ? r.outcome.score.model : null,
        pInjection: r.outcome.ok ? r.outcome.score.pInjection : null,
        pExfil: r.pExfil,
        action: r.action,
        reason: r.reason,
        inputTokens: r.outcome.ok ? r.outcome.score.inputTokens : 0,
        costUsd: r.outcome.ok ? r.outcome.score.costUsd : 0,
        latencyMs: r.outcome.ok ? r.outcome.score.latencyMs : r.outcome.latencyMs,
        status: r.outcome.ok ? "ok" : "error",
        error: r.outcome.ok ? null : r.outcome.error,
        rawJson: r.outcome.ok ? JSON.stringify(r.outcome.score.raw) : null,
      }),
    );
    if (first) await db.batch([first, ...rest]);
  }

  if (x.result || x.error) {
    await db.insert(llmCalls).values({
      id: crypto.randomUUID(),
      requestId: x.requestId,
      createdAt,
      provider: x.provider ?? "",
      model: x.model ?? "",
      inputTokens: x.result?.inputTokens ?? 0,
      outputTokens: x.result?.outputTokens ?? 0,
      reasoningTokens: x.result?.reasoningTokens ?? 0,
      costUsd: x.llmCost,
      latencyMs: x.result?.latencyMs ?? (x.error instanceof ProviderError ? x.error.latencyMs : 0),
      status: x.error ? "error" : "ok",
      error: x.error?.message ?? null,
    });
  }
}
