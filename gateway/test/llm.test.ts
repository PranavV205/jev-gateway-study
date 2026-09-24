import { afterEach, describe, expect, it, vi } from "vitest";
import { answer, type KeyFor } from "../src/providers/llm";

const messages = [{ role: "user" as const, content: "What is the total due?" }];
const keys: KeyFor = (p) => `${p}-key`;
const instant = { sleep: vi.fn(async (_ms: number) => {}), random: () => 0.5 };

const reply = (model: string, content = "The total is $10.") => ({
  model,
  choices: [{ message: { content } }],
  usage: { prompt_tokens: 100, completion_tokens: 10 },
});

type Step = { status: number; body?: unknown; headers?: Record<string, string> };

// Answers each provider's calls from a queue of scripted responses, and records what was sent.
function script(steps: { groq?: Step[]; openrouter?: Step[] }) {
  const sent: { provider: string; body: { model?: string; models?: string[] } }[] = [];
  const queues = { groq: [...(steps.groq ?? [])], openrouter: [...(steps.openrouter ?? [])] };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    const provider = url.includes("groq.com") ? "groq" : "openrouter";
    const body = JSON.parse(String(init?.body));
    sent.push({ provider, body });
    const step = queues[provider].shift();
    if (!step) throw new Error(`No scripted response left for ${provider}`);
    return new Response(JSON.stringify(step.body ?? { error: "failed" }), {
      status: step.status,
      headers: { "Content-Type": "application/json", ...step.headers },
    });
  });
  return sent;
}

afterEach(() => {
  vi.restoreAllMocks();
  instant.sleep.mockClear();
});

describe("answer", () => {
  it("returns the first answer from the primary model", async () => {
    const sent = script({ groq: [{ status: 200, body: reply("openai/gpt-oss-20b") }] });
    const run = await answer("cheap", keys, messages, instant);
    expect(run.final).toMatchObject({ kind: "primary", tier: "cheap", provider: "groq", model: "openai/gpt-oss-20b" });
    expect(run.attempts).toHaveLength(1);
    expect(sent[0]?.body.model).toBe("openai/gpt-oss-20b");
    // 100 in, 10 out at $0.075 / $0.30 per million
    expect(run.final?.costUsd).toBeCloseTo(0.0000105, 10);
  });

  it("retries a 429 with backoff, then succeeds", async () => {
    script({
      groq: [{ status: 429 }, { status: 503 }, { status: 200, body: reply("openai/gpt-oss-20b") }],
    });
    const run = await answer("cheap", keys, messages, instant);
    expect(run.attempts.map((a) => [a.kind, a.result !== null])).toEqual([
      ["primary", false],
      ["retry", false],
      ["retry", true],
    ]);
    // Full jitter at random 0.5: half of 300 ms, then half of 600 ms.
    expect(instant.sleep.mock.calls.map((c) => c[0])).toEqual([150, 300]);
  });

  it("waits for a short Retry-After instead of the backoff", async () => {
    script({
      groq: [
        { status: 429, headers: { "retry-after": "1" } },
        { status: 200, body: reply("openai/gpt-oss-20b") },
      ],
    });
    await answer("cheap", keys, messages, instant);
    expect(instant.sleep.mock.calls.map((c) => c[0])).toEqual([1000]);
  });

  it("skips retries on a long Retry-After and uses the fallback list", async () => {
    const sent = script({
      groq: [{ status: 429, headers: { "retry-after": "60" } }],
      openrouter: [{ status: 200, body: reply("google/gemma-4-26b-a4b-it:free") }],
    });
    const run = await answer("cheap", keys, messages, instant);
    expect(run.attempts.map((a) => a.kind)).toEqual(["primary", "fallback"]);
    expect(run.final).toMatchObject({ provider: "openrouter", model: "google/gemma-4-26b-a4b-it:free" });
    expect(sent[1]?.body.models).toEqual([
      "google/gemma-4-26b-a4b-it:free",
      "qwen/qwen3.8-27b:free",
      "nvidia/nemotron-3-super-120b-a12b:free",
    ]);
    // Priced as the paid gemma model: 100 in, 10 out at $0.09 / $0.30 per million.
    expect(run.final?.costUsd).toBeCloseTo(0.000012, 10);
    expect(instant.sleep).not.toHaveBeenCalled();
  });

  it("does not retry an empty answer or a 4xx, and goes to the fallback", async () => {
    script({
      groq: [{ status: 200, body: reply("openai/gpt-oss-20b", "  ") }],
      openrouter: [{ status: 200, body: reply("google/gemma-4-26b-a4b-it:free") }],
    });
    const empty = await answer("cheap", keys, messages, instant);
    expect(empty.attempts.map((a) => a.kind)).toEqual(["primary", "fallback"]);
    expect(empty.attempts[0]?.error).toContain("empty answer");
    vi.restoreAllMocks();

    script({ groq: [{ status: 400 }], openrouter: [{ status: 200, body: reply("google/gemma-4-26b-a4b-it:free") }] });
    const bad = await answer("cheap", keys, messages, instant);
    expect(bad.attempts.map((a) => a.kind)).toEqual(["primary", "fallback"]);
  });

  it("escalates to the strong tier when the whole cheap tier fails", async () => {
    const long = { "retry-after": "60" };
    const sent = script({
      groq: [
        { status: 429, headers: long },
        { status: 200, body: reply("openai/gpt-oss-120b") },
      ],
      openrouter: [{ status: 503 }],
    });
    const run = await answer("cheap", keys, messages, instant);
    expect(run.attempts.map((a) => [a.kind, a.tier])).toEqual([
      ["primary", "cheap"],
      ["fallback", "cheap"],
      ["escalation", "strong"],
    ]);
    expect(run.final).toMatchObject({ tier: "strong", model: "openai/gpt-oss-120b" });
    expect(sent.map((s) => s.body.model ?? "list")).toEqual(["openai/gpt-oss-20b", "list", "openai/gpt-oss-120b"]);
  });

  it("returns no final answer when every attempt fails", async () => {
    const long = { "retry-after": "60" };
    script({ groq: [{ status: 429, headers: long }], openrouter: [{ status: 503 }] });
    const run = await answer("strong", keys, messages, instant);
    expect(run.final).toBeNull();
    expect(run.attempts.map((a) => a.kind)).toEqual(["primary", "fallback"]);
  });

  it("skips a provider with no API key without retrying it", async () => {
    script({ openrouter: [{ status: 200, body: reply("nvidia/nemotron-3-super-120b-a12b:free") }] });
    const run = await answer("strong", (p) => (p === "openrouter" ? "key" : undefined), messages, instant);
    expect(run.attempts.map((a) => [a.kind, a.error])).toEqual([
      ["primary", "No API key for groq"],
      ["fallback", null],
    ]);
  });
});
