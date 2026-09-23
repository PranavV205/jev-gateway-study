import { describe, expect, it } from "vitest";
import { costUsd, tierModel } from "../src/config";
import { buildMessages, DEFAULT_SYSTEM_PROMPT } from "../src/prompt";

describe("costUsd", () => {
  it("prices input and output tokens per million", () => {
    // gpt-oss-120b: $0.15 in, $0.60 out per million tokens
    expect(costUsd("openai/gpt-oss-120b", 1_000_000, 1_000_000)).toBeCloseTo(0.75);
    expect(costUsd("openai/gpt-oss-20b", 2000, 500)).toBeCloseTo(0.0003);
  });

  it("throws for a model with no configured price", () => {
    expect(() => costUsd("unknown/model", 1, 1)).toThrow(/No price/);
  });
});

describe("tierModel", () => {
  it("maps tiers to the configured models", () => {
    expect(tierModel("cheap").model).toBe("openai/gpt-oss-20b");
    expect(tierModel("strong").model).toBe("openai/gpt-oss-120b");
  });
});

describe("buildMessages", () => {
  it("wraps each chunk with its id and source", () => {
    const [system, user] = buildMessages("What is the total?", [
      { id: "c1", text: "Total due: $10", source: "invoice.md#1" },
      { id: "c2", text: "Net 30" },
    ]);
    expect(system?.content).toBe(DEFAULT_SYSTEM_PROMPT);
    expect(user?.content).toContain('<chunk id="c1" source="invoice.md#1">\nTotal due: $10\n</chunk>');
    expect(user?.content).toContain('<chunk id="c2">\nNet 30\n</chunk>');
    expect(user?.content).toMatch(/Question: What is the total\?$/);
  });

  it("uses a caller-supplied system prompt", () => {
    const [system] = buildMessages("Hi", [], "Be brief.");
    expect(system?.content).toBe("Be brief.");
  });
});
