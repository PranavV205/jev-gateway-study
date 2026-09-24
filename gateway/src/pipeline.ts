import { drizzle } from "drizzle-orm/d1";
import type { Classifier, Router } from "./classifiers/base";
import { JevClassifier } from "./classifiers/jev";
import { config, costUsd, type Tier, tierModel } from "./config";
import { llmCalls, requests, routeDecisions, screenResults } from "./db/schema";
import { buildMessages } from "./prompt";
import { type AnswerRun, answer, type KeyFor } from "./providers/llm";
import { type RouteRun, route, routeReport } from "./route";
import type { ChatRequest } from "./schemas";
import { type ScreenRun, screen, screenReport } from "./screen";

export interface GatewayReport {
  request_id: string;
  action: "allowed" | "refused" | "error";
  dropped_chunks: string[];
  tier: Tier | null;
  provider: string | null;
  model: string | null;
  route: ReturnType<typeof routeReport>;
  screen: ReturnType<typeof screenReport>;
  cost_usd: number;
  baseline_cost_usd: number;
  latency_ms: { screen: number; route: number; model: number; total: number };
  // Every model call made for this request, in order: retries, fallbacks, and escalations included.
  llm_attempts: { kind: string; tier: Tier; provider: string; model: string; ok: boolean; latency_ms: number }[];
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

function keysFrom(env: Env): KeyFor {
  return (provider) => (provider === "groq" ? env.GROQ_API_KEY : env.OPENROUTER_API_KEY) || undefined;
}

export function makeClassifier(env: Env, name: ChatRequest["options"]["classifier"]): Classifier | null {
  return name === "jev" ? new JevClassifier(env.TYPESAFE_API_KEY) : null;
}

export function makeRouter(env: Env, name: ChatRequest["options"]["router"]): Router | null {
  return name === "jev" ? new JevClassifier(env.TYPESAFE_API_KEY) : null;
}

export async function handleChat(
  env: Env,
  req: ChatRequest,
  classifier: Classifier | null = makeClassifier(env, req.options.classifier),
  router: Router | null = makeRouter(env, req.options.router),
): Promise<ChatResponse> {
  const start = Date.now();
  const requestId = crypto.randomUUID();

  // Screening and routing both only need the request, so they run at the same time.
  const [run, routed] = await Promise.all([
    screen(classifier, req.user_message, req.context_chunks),
    route(router, req.user_message, req.options.force_tier),
  ]);
  const refused = run.decision.action === "refused";
  const dropped = new Set(run.decision.chunks.filter((c) => c.action === "dropped").map((c) => c.id));
  const keptChunks = req.context_chunks.filter((c) => !dropped.has(c.id));

  const llm: AnswerRun | null =
    refused || req.options.dry_run
      ? null
      : await answer(routed.tier, keysFrom(env), buildMessages(req.user_message, keptChunks, req.system_prompt));

  const final = llm?.final ?? null;
  const result = final?.result ?? null;
  const lastAttempt = llm?.attempts.at(-1) ?? null;
  const error = llm && !final ? new Error(lastAttempt?.error ?? "No model call succeeded") : null;
  // The tier and model that answered. After an escalation this is the strong tier even
  // though the router picked cheap.
  const answeredBy = final ?? lastAttempt;

  const llmCost = llm?.attempts.reduce((sum, a) => sum + a.costUsd, 0) ?? 0;
  // What the same tokens would have cost on the strong tier with no screening. Output length
  // would differ on another model, so this is an estimate.
  const baselineCost = result ? costUsd(tierModel("strong").model, result.inputTokens, result.outputTokens) : 0;
  const action = refused ? "refused" : error ? "error" : "allowed";
  const totalMs = Date.now() - start;

  await log(env, {
    requestId,
    req,
    run,
    routed,
    action,
    tier: answeredBy?.tier ?? null,
    provider: answeredBy?.provider ?? null,
    model: answeredBy?.model ?? null,
    llmCost,
    baselineCost,
    totalMs,
    llm,
    error,
  });

  return {
    answer: result?.content ?? null,
    gateway: {
      request_id: requestId,
      action,
      dropped_chunks: [...dropped],
      tier: answeredBy?.tier ?? null,
      provider: answeredBy?.provider ?? null,
      model: answeredBy?.model ?? null,
      route: routeReport(routed),
      screen: screenReport(run),
      cost_usd: llmCost + run.costUsd + routed.costUsd,
      baseline_cost_usd: baselineCost,
      latency_ms: {
        screen: run.latencyMs,
        route: routed.latencyMs,
        model: llm?.attempts.reduce((sum, a) => sum + a.latencyMs, 0) ?? 0,
        total: totalMs,
      },
      llm_attempts:
        llm?.attempts.map((a) => ({
          kind: a.kind,
          tier: a.tier,
          provider: a.provider,
          model: a.model,
          ok: a.result !== null,
          latency_ms: a.latencyMs,
        })) ?? [],
      ...(error ? { error: error.message } : {}),
    },
  };
}

interface LogInput {
  requestId: string;
  req: ChatRequest;
  run: ScreenRun;
  routed: RouteRun;
  action: GatewayReport["action"];
  tier: Tier | null;
  provider: string | null;
  model: string | null;
  llmCost: number;
  baselineCost: number;
  totalMs: number;
  llm: AnswerRun | null;
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
    router: x.routed.router,
    routeReason: x.routed.reason,
    tier: x.tier,
    provider: x.provider,
    model: x.model,
    costUsd: x.llmCost + x.run.costUsd + x.routed.costUsd,
    screenCostUsd: x.run.costUsd,
    routeCostUsd: x.routed.costUsd,
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

  const r = x.routed.outcome;
  if (r) {
    await db.insert(routeDecisions).values({
      id: crypto.randomUUID(),
      requestId: x.requestId,
      router: x.routed.router,
      model: r.ok ? r.score.model : null,
      taskType: r.ok ? r.score.taskType : null,
      taskProbsJson: r.ok ? JSON.stringify(r.score.taskProbs) : null,
      confidence: r.ok ? r.score.confidence : null,
      pNeedsStrong: r.ok ? r.score.pNeedsStrong : null,
      tier: x.routed.tier,
      reason: x.routed.reason,
      inputTokens: r.ok ? r.score.inputTokens : 0,
      costUsd: x.routed.costUsd,
      latencyMs: x.routed.latencyMs,
      status: r.ok ? "ok" : "error",
      error: r.ok ? null : r.error,
    });
  }

  const attempts = x.llm?.attempts ?? [];
  const [first, ...rest] = attempts.map((a, i) =>
    db.insert(llmCalls).values({
      id: crypto.randomUUID(),
      requestId: x.requestId,
      createdAt,
      attempt: i + 1,
      kind: a.kind,
      tier: a.tier,
      provider: a.provider,
      model: a.model,
      inputTokens: a.result?.inputTokens ?? 0,
      outputTokens: a.result?.outputTokens ?? 0,
      reasoningTokens: a.result?.reasoningTokens ?? 0,
      costUsd: a.costUsd,
      latencyMs: a.latencyMs,
      status: a.result ? "ok" : "error",
      error: a.error,
    }),
  );
  if (first) await db.batch([first, ...rest]);
}
