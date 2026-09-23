import raw from "../../config/default.json";

export type Tier = "cheap" | "strong";
export type ProviderName = keyof typeof raw.providers;

export interface ModelPrice {
  input: number;
  output: number;
}

export const config = raw;

export function tierModel(tier: Tier): { provider: ProviderName; model: string } {
  const t = config.tiers[tier];
  return { provider: t.provider as ProviderName, model: t.model };
}

export function priceOf(model: string): ModelPrice {
  const price = (config.prices as Record<string, ModelPrice | string>)[model];
  if (!price || typeof price === "string") throw new Error(`No price configured for model ${model}`);
  return price;
}

// USD for a call, from published per-million-token prices.
export function costUsd(model: string, inputTokens: number, outputTokens: number): number {
  const p = priceOf(model);
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}
