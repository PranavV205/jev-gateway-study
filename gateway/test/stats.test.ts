import { describe, expect, it } from "vitest";
import {
  computeStats,
  type LlmRow,
  percentile,
  type RequestRow,
  type RouteRow,
  type ScreenRow,
  sinceFor,
} from "../src/stats";

const req = (id: string, overrides: Partial<RequestRow> = {}): RequestRow => ({
  id,
  created_at: "2026-09-24T10:15:00.000Z",
  app_id: "doc-qa",
  action: "allowed",
  flagged: 0,
  tier: "strong",
  cost_usd: 0.0003,
  screen_cost_usd: 0.0001,
  route_cost_usd: 0.00002,
  baseline_cost_usd: 0.0002,
  latency_ms: 1000,
  screen_latency_ms: 400,
  ...overrides,
});

const screen = (
  request_id: string,
  target: string,
  p: number,
  action: string,
  reason: string | null = null,
): ScreenRow => ({
  request_id,
  created_at: "2026-09-24T10:15:00.000Z",
  target,
  p_injection: p,
  p_exfil: 0.01,
  action,
  reason,
  status: "ok",
});

const route = (request_id: string, task_type: string, tier: string, reason: string): RouteRow => ({
  request_id,
  created_at: "2026-09-24T10:15:00.000Z",
  task_type,
  confidence: 0.9,
  p_needs_strong: 0.1,
  tier,
  reason,
  latency_ms: 300,
});

const llm = (request_id: string, kind: string, provider: string, status: string): LlmRow => ({
  request_id,
  created_at: "2026-09-24T10:15:00.000Z",
  kind,
  provider,
  model: provider === "groq" ? "openai/gpt-oss-20b" : "google/gemma-4-26b-a4b-it:free",
  status,
  latency_ms: 500,
});

describe("percentile", () => {
  it("uses the nearest-rank method", () => {
    const s = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(s, 50)).toBe(50);
    expect(percentile(s, 95)).toBe(100);
    expect(percentile([], 50)).toBeNull();
  });
});

describe("sinceFor", () => {
  it("subtracts the range, or returns null for all", () => {
    const now = Date.parse("2026-09-24T12:00:00Z");
    expect(sinceFor("24h", now)).toBe("2026-09-23T12:00:00.000Z");
    expect(sinceFor("all", now)).toBeNull();
  });
});

describe("computeStats", () => {
  const reqs = [
    req("a", { tier: "cheap" }),
    req("b"),
    req("c", {
      action: "refused",
      tier: null,
      cost_usd: 0.00005,
      baseline_cost_usd: 0,
      created_at: "2026-09-24T11:05:00.000Z",
    }),
    req("d", { action: "error", baseline_cost_usd: 0, flagged: 1 }),
  ];
  const screens = [
    screen("a", "user", 0.01, "allowed"),
    screen("a", "a#1", 0.02, "kept"),
    screen("b", "user", 0.02, "allowed"),
    screen("b", "b#1", 0.96, "dropped", "injection"),
    screen("b", "b#2", 0.45, "kept"),
    screen("c", "user", 0.99, "refused", "injection"),
  ];
  const routes = [route("a", "lookup", "cheap", "cheap_task"), route("b", "lookup", "strong", "needs_strong")];
  const llms = [
    llm("a", "primary", "groq", "error"),
    llm("a", "fallback", "openrouter", "ok"),
    llm("b", "primary", "groq", "ok"),
  ];
  const s = computeStats(reqs, screens, routes, llms, "24h");

  it("counts requests by outcome", () => {
    expect(s.totals).toEqual({ requests: 4, allowed: 2, refused: 1, errors: 1, flagged: 1 });
  });

  it("compares cost only on answered requests", () => {
    expect(s.cost.answered.requests).toBe(2);
    expect(s.cost.answered.gateway_usd).toBeCloseTo(0.0006, 10);
    expect(s.cost.answered.baseline_usd).toBeCloseTo(0.0004, 10);
    expect(s.cost.answered.llm_usd).toBeCloseTo(2 * 0.00018, 10);
    expect(s.cost.total_usd).toBeCloseTo(0.00095, 10);
  });

  it("buckets by hour for a 24h range", () => {
    expect(s.bucket).toBe("hour");
    expect(s.cost.series.map((b) => [b.bucket, b.requests])).toEqual([
      ["2026-09-24T10:00Z", 3],
      ["2026-09-24T11:00Z", 1],
    ]);
  });

  it("summarizes routing and threats", () => {
    expect(s.routing).toMatchObject({ routed: 2, cheap: 1, cheap_share: 0.5 });
    expect(s.routing.by_task).toEqual([{ task_type: "lookup", cheap: 1, strong: 1 }]);
    expect(s.threats).toMatchObject({
      questions_screened: 3,
      questions_refused: 1,
      chunks_screened: 3,
      chunks_dropped: 1,
      drop_reasons: { injection: 1, exfiltration: 0, screen_failed: 0 },
    });
  });

  it("bins scores into ten buckets", () => {
    expect(s.scores.chunk_injection).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    expect(s.scores.user_injection.reduce((a, b) => a + b, 0)).toBe(3);
  });

  it("counts attempts and fallback answers", () => {
    expect(s.reliability.attempts).toEqual({ primary: 2, retry: 0, fallback: 1, escalation: 0 });
    expect(s.reliability.answered_by_fallback).toBe(1);
  });

  it("lists borderline and unusual cases, newest first", () => {
    const kinds = s.recent.map((r) => r.kind);
    expect(kinds).toContain("Borderline chunk");
    expect(kinds).toContain("Unsure route");
    expect(kinds).toContain("Fallback");
    expect(kinds).toContain("Error");
    expect((s.recent[0]?.created_at ?? "") >= (s.recent.at(-1)?.created_at ?? "")).toBe(true);
  });
});
