import { describe, expect, it } from "vitest";
import {
  type ChunkInput,
  decideChunk,
  decideRoute,
  decideScreen,
  type FailPolicy,
  type RouteRules,
  type Thresholds,
} from "../src/policy";

const t: Thresholds = { userInjection: 0.3, chunkInjection: 0.5, exfiltration: 0.5 };
const fail: FailPolicy = { user: "allow", chunk: "drop" };
const chunk = (pInjection: number | null, pExfil: number | null = 0.01): ChunkInput => ({
  id: "c",
  pInjection,
  pExfil,
});

describe("decideChunk", () => {
  it.each([
    ["clean", chunk(0.1), null],
    ["injection at the threshold", chunk(0.5), "injection"],
    ["injection above the threshold", chunk(0.97), "injection"],
    ["exfiltration only", chunk(0.2, 0.8), "exfiltration"],
    ["injection wins over exfiltration", chunk(0.9, 0.9), "injection"],
    ["just under both thresholds", chunk(0.49, 0.49), null],
    ["screening failed, fail closed", chunk(null, null), "screen_failed"],
  ] as const)("%s", (_, input, expected) => {
    expect(decideChunk(input, t, fail)).toBe(expected);
  });

  it("keeps an unscreened chunk when the fail policy says keep", () => {
    expect(decideChunk(chunk(null, null), t, { ...fail, chunk: "keep" })).toBeNull();
  });
});

describe("decideScreen", () => {
  it("allows a clean request and keeps every chunk", () => {
    const d = decideScreen({ pInjection: 0.05 }, [{ id: "a", pInjection: 0.1, pExfil: 0.1 }], t, fail);
    expect(d).toEqual({
      action: "allowed",
      flagged: false,
      userReason: null,
      chunks: [{ id: "a", action: "kept", reason: null }],
    });
  });

  it("refuses when the user message crosses its threshold", () => {
    const d = decideScreen({ pInjection: 0.3 }, [], t, fail);
    expect(d).toMatchObject({ action: "refused", userReason: "injection" });
  });

  it("drops only the bad chunks", () => {
    const d = decideScreen(
      { pInjection: 0.02 },
      [
        { id: "a", pInjection: 0.02, pExfil: 0.02 },
        { id: "b", pInjection: 0.95, pExfil: 0.1 },
        { id: "c", pInjection: 0.1, pExfil: 0.7 },
      ],
      t,
      fail,
    );
    expect(d.action).toBe("allowed");
    expect(d.chunks.map((c) => [c.id, c.action, c.reason])).toEqual([
      ["a", "kept", null],
      ["b", "dropped", "injection"],
      ["c", "dropped", "exfiltration"],
    ]);
  });

  it("allows and flags an unscreened user message by default", () => {
    expect(decideScreen({ pInjection: null }, [], t, fail)).toMatchObject({
      action: "allowed",
      flagged: true,
      userReason: "screen_failed",
    });
  });

  it("refuses an unscreened user message when the fail policy says refuse", () => {
    expect(decideScreen({ pInjection: null }, [], t, { ...fail, user: "refuse" })).toMatchObject({
      action: "refused",
      flagged: false,
      userReason: "screen_failed",
    });
  });
});

describe("decideRoute", () => {
  const rules: RouteRules = { cheapTasks: ["lookup", "extraction"], minCheapProbability: 0.8, maxNeedsStrong: 0.3 };
  const auto = { forced: null, failed: false };
  const r = (taskProbs: Record<string, number>, pNeedsStrong = 0.05) => ({ taskProbs, pNeedsStrong });

  it.each([
    ["clear lookup", r({ lookup: 0.95, reasoning: 0.05 }), { tier: "cheap", reason: "cheap_task" }],
    [
      "split between the two cheap types",
      r({ lookup: 0.45, extraction: 0.45, other: 0.1 }),
      { tier: "cheap", reason: "cheap_task" },
    ],
    [
      "cheap probability exactly at the minimum",
      r({ lookup: 0.8, summary: 0.2 }),
      { tier: "cheap", reason: "cheap_task" },
    ],
    [
      "cheap probability just under the minimum",
      r({ lookup: 0.79, reasoning: 0.21 }),
      { tier: "strong", reason: "strong_task" },
    ],
    ["reasoning", r({ reasoning: 0.99, lookup: 0.01 }), { tier: "strong", reason: "strong_task" }],
    ["other", r({ other: 0.9, lookup: 0.1 }), { tier: "strong", reason: "strong_task" }],
    ["cheap task that needs strong", r({ lookup: 0.95 }, 0.3), { tier: "strong", reason: "needs_strong" }],
  ] as const)("%s", (_, input, expected) => {
    expect(decideRoute(input, rules, auto)).toEqual(expected);
  });

  it("honors a forced tier over everything", () => {
    expect(decideRoute(r({ reasoning: 1 }, 0.9), rules, { forced: "cheap", failed: false })).toEqual({
      tier: "cheap",
      reason: "forced",
    });
  });

  it("falls back to strong when routing failed or was skipped", () => {
    expect(decideRoute(null, rules, { forced: null, failed: true })).toEqual({
      tier: "strong",
      reason: "route_failed",
    });
    expect(decideRoute(null, rules, auto)).toEqual({ tier: "strong", reason: "no_router" });
  });
});
