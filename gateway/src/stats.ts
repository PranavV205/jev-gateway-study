// Aggregates the gateway's logs for the dashboard. Loading is a few flat queries; the
// maths is a pure function so it can be tested without a database.

import { config } from "./config";

export interface RequestRow {
  id: string;
  created_at: string;
  app_id: string;
  action: "allowed" | "refused" | "error";
  flagged: number;
  tier: string | null;
  cost_usd: number;
  screen_cost_usd: number;
  route_cost_usd: number;
  baseline_cost_usd: number;
  latency_ms: number;
  screen_latency_ms: number;
}

export interface ScreenRow {
  request_id: string;
  created_at: string;
  target: string;
  p_injection: number | null;
  p_exfil: number | null;
  action: string;
  reason: string | null;
  status: string;
}

export interface RouteRow {
  request_id: string;
  created_at: string;
  task_type: string | null;
  confidence: number | null;
  p_needs_strong: number | null;
  tier: string;
  reason: string;
  latency_ms: number;
}

export interface LlmRow {
  request_id: string;
  created_at: string;
  kind: string;
  provider: string;
  model: string;
  status: string;
  latency_ms: number;
}

export type Range = "24h" | "7d" | "30d" | "all";

const RANGE_MS: Record<Exclude<Range, "all">, number> = {
  "24h": 24 * 3600_000,
  "7d": 7 * 24 * 3600_000,
  "30d": 30 * 24 * 3600_000,
};

// Cap on requests loaded per call. The dashboard is a monitoring view, not a report.
export const MAX_REQUESTS = 5000;

export function sinceFor(range: Range, now: number): string | null {
  return range === "all" ? null : new Date(now - RANGE_MS[range]).toISOString();
}

export function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i] ?? null;
}

function summary(values: number[]) {
  const s = [...values].sort((a, b) => a - b);
  return { n: s.length, p50: percentile(s, 50), p95: percentile(s, 95), p99: percentile(s, 99) };
}

function histogram(values: number[], bins = 10): number[] {
  const out = new Array<number>(bins).fill(0);
  for (const v of values) {
    const i = Math.min(bins - 1, Math.floor(v * bins));
    out[i] = (out[i] ?? 0) + 1;
  }
  return out;
}

// Hourly buckets for short ranges, daily otherwise.
function bucketOf(iso: string, unit: "hour" | "day"): string {
  return unit === "hour" ? `${iso.slice(0, 13)}:00Z` : iso.slice(0, 10);
}

export function computeStats(
  reqs: RequestRow[],
  screens: ScreenRow[],
  routes: RouteRow[],
  llms: LlmRow[],
  range: Range,
) {
  const first = reqs.reduce<string | null>((m, r) => (m === null || r.created_at < m ? r.created_at : m), null);
  const last = reqs.reduce<string | null>((m, r) => (m === null || r.created_at > m ? r.created_at : m), null);
  const spanMs = first && last ? Date.parse(last) - Date.parse(first) : 0;
  const unit: "hour" | "day" = range === "24h" || (range === "all" && spanMs <= 48 * 3600_000) ? "hour" : "day";

  // Cost is compared only on answered requests: a refused request has no all-strong baseline.
  const answered = reqs.filter((r) => r.action === "allowed" && r.baseline_cost_usd > 0);
  const sum = (rows: RequestRow[], f: (r: RequestRow) => number) => rows.reduce((s, r) => s + f(r), 0);
  const llmCost = (r: RequestRow) => r.cost_usd - r.screen_cost_usd - r.route_cost_usd;

  const buckets = new Map<string, { requests: number; llm: number; screen: number; route: number; baseline: number }>();
  for (const r of reqs) {
    const k = bucketOf(r.created_at, unit);
    const b = buckets.get(k) ?? { requests: 0, llm: 0, screen: 0, route: 0, baseline: 0 };
    b.requests += 1;
    b.llm += llmCost(r);
    b.screen += r.screen_cost_usd;
    b.route += r.route_cost_usd;
    b.baseline += r.baseline_cost_usd;
    buckets.set(k, b);
  }

  const tasks = new Map<string, { cheap: number; strong: number }>();
  const routeReasons: Record<string, number> = {};
  for (const r of routes) {
    const t = r.task_type ?? "unrouted";
    const row = tasks.get(t) ?? { cheap: 0, strong: 0 };
    if (r.tier === "cheap") row.cheap += 1;
    else row.strong += 1;
    tasks.set(t, row);
    routeReasons[r.reason] = (routeReasons[r.reason] ?? 0) + 1;
  }
  const taskOrder = ["lookup", "extraction", "summary", "reasoning", "other", "unrouted"];

  const chunkRows = screens.filter((s) => s.target !== "user");
  const userRows = screens.filter((s) => s.target === "user");
  const dropReasons: Record<string, number> = { injection: 0, exfiltration: 0, screen_failed: 0 };
  for (const s of chunkRows)
    if (s.action === "dropped" && s.reason) dropReasons[s.reason] = (dropReasons[s.reason] ?? 0) + 1;

  const attemptKinds: Record<string, number> = { primary: 0, retry: 0, fallback: 0, escalation: 0 };
  for (const l of llms) attemptKinds[l.kind] = (attemptKinds[l.kind] ?? 0) + 1;
  const answeredBy = new Map<string, LlmRow>();
  for (const l of llms) if (l.status === "ok") answeredBy.set(l.request_id, l);

  const t = config.screening.thresholds;
  const borderline = (p: number | null, threshold: number) =>
    p !== null && p >= threshold - 0.25 && p < threshold + 0.25;
  const recent: { request_id: string; created_at: string; kind: string; detail: string }[] = [
    ...userRows
      .filter((s) => borderline(s.p_injection, t.userInjection))
      .map((s) => ({
        request_id: s.request_id,
        created_at: s.created_at,
        kind: "Borderline question",
        detail: `injection ${s.p_injection?.toFixed(2)} (refuse at ${t.userInjection}), ${s.action}`,
      })),
    ...chunkRows
      .filter((s) => borderline(s.p_injection, t.chunkInjection) || borderline(s.p_exfil, t.exfiltration))
      .map((s) => ({
        request_id: s.request_id,
        created_at: s.created_at,
        kind: "Borderline chunk",
        detail: `${s.target}: injection ${s.p_injection?.toFixed(2)}, exfiltration ${s.p_exfil?.toFixed(2)}, ${s.action}`,
      })),
    ...routes
      .filter((r) => r.reason !== "cheap_task" && r.task_type && ["lookup", "extraction"].includes(r.task_type))
      .map((r) => ({
        request_id: r.request_id,
        created_at: r.created_at,
        kind: "Unsure route",
        detail: `${r.task_type}, needs strong ${r.p_needs_strong?.toFixed(2)}, sent to ${r.tier} (${r.reason})`,
      })),
    ...llms
      .filter((l) => l.kind !== "primary" && l.status === "ok")
      .map((l) => ({
        request_id: l.request_id,
        created_at: l.created_at,
        kind: l.kind === "escalation" ? "Escalated" : l.kind === "fallback" ? "Fallback" : "Retried",
        detail: `answered by ${l.model} via ${l.provider}`,
      })),
    ...reqs
      .filter((r) => r.action === "error")
      .map((r) => ({ request_id: r.id, created_at: r.created_at, kind: "Error", detail: "no model call succeeded" })),
  ]
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, 25);

  const cheapRoutes = routes.filter((r) => r.tier === "cheap").length;

  return {
    range,
    bucket: unit,
    from: first,
    to: last,
    note: "Costs use published paid prices. This project runs on free tiers.",
    totals: {
      requests: reqs.length,
      allowed: reqs.filter((r) => r.action === "allowed").length,
      refused: reqs.filter((r) => r.action === "refused").length,
      errors: reqs.filter((r) => r.action === "error").length,
      flagged: reqs.filter((r) => r.flagged).length,
    },
    cost: {
      total_usd: sum(reqs, (r) => r.cost_usd),
      answered: {
        requests: answered.length,
        gateway_usd: sum(answered, (r) => r.cost_usd),
        llm_usd: sum(answered, llmCost),
        screen_usd: sum(answered, (r) => r.screen_cost_usd),
        route_usd: sum(answered, (r) => r.route_cost_usd),
        baseline_usd: sum(answered, (r) => r.baseline_cost_usd),
      },
      series: [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([bucket, v]) => ({ bucket, ...v })),
    },
    routing: {
      routed: routes.length,
      cheap: cheapRoutes,
      cheap_share: routes.length ? cheapRoutes / routes.length : null,
      by_task: [...tasks.entries()]
        .sort(([a], [b]) => taskOrder.indexOf(a) - taskOrder.indexOf(b))
        .map(([task_type, v]) => ({ task_type, ...v })),
      reasons: routeReasons,
    },
    threats: {
      questions_screened: userRows.length,
      questions_refused: userRows.filter((s) => s.action === "refused").length,
      chunks_screened: chunkRows.length,
      chunks_dropped: chunkRows.filter((s) => s.action === "dropped").length,
      drop_reasons: dropReasons,
      screen_errors: screens.filter((s) => s.status === "error").length,
    },
    scores: {
      thresholds: t,
      chunk_injection: histogram(chunkRows.flatMap((s) => (s.p_injection === null ? [] : [s.p_injection]))),
      user_injection: histogram(userRows.flatMap((s) => (s.p_injection === null ? [] : [s.p_injection]))),
    },
    latency: {
      total: summary(reqs.map((r) => r.latency_ms)),
      screen: summary(reqs.filter((r) => r.screen_latency_ms > 0).map((r) => r.screen_latency_ms)),
      route: summary(routes.map((r) => r.latency_ms)),
      model: summary(llms.filter((l) => l.status === "ok").map((l) => l.latency_ms)),
    },
    reliability: {
      attempts: attemptKinds,
      answered_by_fallback: [...answeredBy.values()].filter((l) => l.provider !== "groq").length,
      answered_by_escalation: [...answeredBy.values()].filter((l) => l.kind === "escalation").length,
    },
    recent,
  };
}

export type Stats = ReturnType<typeof computeStats>;

export async function loadStats(db: D1Database, range: Range, app: string | null, now = Date.now()): Promise<Stats> {
  const since = sinceFor(range, now);
  const where = ["1 = 1"];
  const params: string[] = [];
  if (since) {
    where.push("r.created_at >= ?");
    params.push(since);
  }
  if (app) {
    where.push("r.app_id = ?");
    params.push(app);
  }
  // The newest MAX_REQUESTS requests in range; child tables are joined to the same set.
  const scope = `SELECT id FROM requests r WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT ${MAX_REQUESTS}`;
  const q = <T>(sql: string) =>
    db
      .prepare(sql)
      .bind(...params)
      .all<T>()
      .then((r) => r.results);

  const [reqs, screens, routes, llms] = await Promise.all([
    q<RequestRow>(
      `SELECT id, created_at, app_id, action, flagged, tier, cost_usd, screen_cost_usd, route_cost_usd,
              baseline_cost_usd, latency_ms, screen_latency_ms
         FROM requests WHERE id IN (${scope})`,
    ),
    q<ScreenRow>(
      `SELECT s.request_id, r.created_at, s.target, s.p_injection, s.p_exfil, s.action, s.reason, s.status
         FROM screen_results s JOIN requests r ON r.id = s.request_id WHERE s.request_id IN (${scope})`,
    ),
    q<RouteRow>(
      `SELECT d.request_id, r.created_at, d.task_type, d.confidence, d.p_needs_strong, d.tier, d.reason, d.latency_ms
         FROM route_decisions d JOIN requests r ON r.id = d.request_id WHERE d.request_id IN (${scope})`,
    ),
    q<LlmRow>(
      `SELECT l.request_id, l.created_at, l.kind, l.provider, l.model, l.status, l.latency_ms
         FROM llm_calls l WHERE l.request_id IN (${scope})`,
    ),
  ]);
  return computeStats(reqs, screens, routes, llms, range);
}

export function listApps(db: D1Database): Promise<string[]> {
  return db
    .prepare("SELECT DISTINCT app_id FROM requests ORDER BY app_id")
    .all<{ app_id: string }>()
    .then((r) => r.results.map((x) => x.app_id));
}
