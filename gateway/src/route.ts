import type { Router, RouteScore } from "./classifiers/base";
import { config, type Tier } from "./config";
import { decideRoute, type RouteReason } from "./policy";
import { type Outcome, settle } from "./screen";

export interface RouteRun {
  router: string;
  outcome: Outcome<RouteScore> | null;
  tier: Tier;
  reason: RouteReason;
  costUsd: number;
  latencyMs: number;
}

// Picks a tier for the question. The router is not called when the caller forces a tier.
export async function route(router: Router | null, question: string, forced: Tier | null): Promise<RouteRun> {
  const name = router?.name ?? "none";
  if (!router || forced) {
    const d = decideRoute(null, config.routing, { forced, failed: false });
    return { router: name, outcome: null, ...d, costUsd: 0, latencyMs: 0 };
  }

  const start = Date.now();
  const outcome = await settle(() => router.route(question));
  const d = decideRoute(outcome.ok ? outcome.score : null, config.routing, { forced: null, failed: !outcome.ok });
  return {
    router: name,
    outcome,
    ...d,
    costUsd: outcome.ok ? outcome.score.costUsd : 0,
    latencyMs: Date.now() - start,
  };
}

// The part of the routing result that goes back to the caller.
export function routeReport(run: RouteRun) {
  const s = run.outcome?.ok ? run.outcome.score : null;
  return {
    router: run.router,
    task_type: s?.taskType ?? null,
    confidence: s?.confidence ?? null,
    p_needs_strong: s?.pNeedsStrong ?? null,
    tier: run.tier,
    reason: run.reason,
  };
}
