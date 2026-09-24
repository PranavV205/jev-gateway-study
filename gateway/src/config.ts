import raw from "../../config/default.json";

export type Tier = "cheap" | "strong";
export type ProviderName = keyof typeof raw.providers;

export interface ModelPrice {
  input: number;
  output: number;
}

export const config = raw;

export interface TierConfig {
  provider: ProviderName;
  model: string;
  fallback: { provider: ProviderName; models: string[] } | null;
}

export function tierModel(tier: Tier): TierConfig {
  const t = config.tiers[tier];
  return {
    provider: t.provider as ProviderName,
    model: t.model,
    fallback: t.fallback ? { provider: t.fallback.provider as ProviderName, models: t.fallback.models } : null,
  };
}

// A ":free" model is priced as its paid version, so costs compare like for like.
export function priceOf(model: string): ModelPrice {
  const price = (config.prices as Record<string, ModelPrice | string>)[model.replace(/:free$/, "")];
  if (!price || typeof price === "string") throw new Error(`No price configured for model ${model}`);
  return price;
}

// USD for a call, from published per-million-token prices.
export function costUsd(model: string, inputTokens: number, outputTokens: number): number {
  const p = priceOf(model);
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}
