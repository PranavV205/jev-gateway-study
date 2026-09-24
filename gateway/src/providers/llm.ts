import { config, costUsd, type ProviderName, type Tier, tierModel } from "../config";
import { backoffMs, sleep } from "../infra/backoff";
import { type ChatMessage, type ChatResult, chat, type ModelTarget, ProviderError } from "./chat";

export type AttemptKind = "primary" | "retry" | "fallback" | "escalation";

export interface Attempt {
  kind: AttemptKind;
  tier: Tier;
  provider: ProviderName;
  // The model that answered, or the first requested model if the call failed.
  model: string;
  result: ChatResult | null;
  error: string | null;
  latencyMs: number;
  costUsd: number;
}

export interface AnswerRun {
  attempts: Attempt[];
  // The attempt that produced the answer, if any.
  final: Attempt | null;
}

export type KeyFor = (provider: ProviderName) => string | undefined;

export interface LlmDeps {
  sleep: (ms: number) => Promise<void>;
  random: () => number;
}

const defaultDeps: LlmDeps = { sleep, random: Math.random };

function priced(model: string, fallbackModel: string, r: ChatResult): number {
  // An OpenRouter reply can name a model variant we have no price for; fall back to the
  // model we asked for.
  try {
    return costUsd(model, r.inputTokens, r.outputTokens);
  } catch {
    return costUsd(fallbackModel, r.inputTokens, r.outputTokens);
  }
}

async function attempt(
  kind: AttemptKind,
  tier: Tier,
  provider: ProviderName,
  target: ModelTarget,
  keyFor: KeyFor,
  messages: ChatMessage[],
): Promise<{ a: Attempt; err: ProviderError | null }> {
  const requested = "model" in target ? target.model : (target.models[0] ?? "");
  const failed = (err: ProviderError) => ({
    a: {
      kind,
      tier,
      provider,
      model: requested,
      result: null,
      error: err.message,
      latencyMs: err.latencyMs,
      costUsd: 0,
    },
    err,
  });

  const key = keyFor(provider);
  // A missing key is a configuration error, not something a retry fixes (status 401-like).
  if (!key) return failed(new ProviderError(`No API key for ${provider}`, 401, 0));
  try {
    const result = await chat(provider, key, target, messages);
    const a: Attempt = {
      kind,
      tier,
      provider,
      model: result.model,
      result,
      error: null,
      latencyMs: result.latencyMs,
      costUsd: priced(result.model, requested, result),
    };
    return { a, err: null };
  } catch (err) {
    return failed(err instanceof ProviderError ? err : new ProviderError(String(err), null, 0));
  }
}

// Tries one tier: the primary model with retries, then the fallback provider's model list.
async function tryTier(
  tier: Tier,
  firstKind: "primary" | "escalation",
  keyFor: KeyFor,
  messages: ChatMessage[],
  deps: LlmDeps,
  attempts: Attempt[],
): Promise<Attempt | null> {
  const t = tierModel(tier);
  const { retry } = config.llm;

  for (let i = 0; i <= retry.maxRetries; i++) {
    const { a, err } = await attempt(
      i === 0 ? firstKind : "retry",
      tier,
      t.provider,
      { model: t.model },
      keyFor,
      messages,
    );
    attempts.push(a);
    if (!err) return a;
    if (!err.retryable || i === retry.maxRetries) break;
    // A long Retry-After usually means a quota window, not a blip. Go to the fallback instead.
    if (err.retryAfterMs !== null && err.retryAfterMs > retry.maxRetryAfterMs) break;
    await deps.sleep(Math.max(backoffMs(i, retry, deps.random), err.retryAfterMs ?? 0));
  }

  if (t.fallback) {
    const { a, err } = await attempt(
      "fallback",
      tier,
      t.fallback.provider,
      { models: t.fallback.models },
      keyFor,
      messages,
    );
    attempts.push(a);
    if (!err) return a;
  }
  return null;
}

// Gets an answer for the chosen tier. If the cheap tier fails completely, the strong tier
// gets a turn, since a slower or pricier answer beats no answer.
export async function answer(
  tier: Tier,
  keyFor: KeyFor,
  messages: ChatMessage[],
  deps: LlmDeps = defaultDeps,
): Promise<AnswerRun> {
  const attempts: Attempt[] = [];
  let final = await tryTier(tier, "primary", keyFor, messages, deps, attempts);
  if (!final && tier === "cheap" && config.llm.escalateCheapFailures) {
    final = await tryTier("strong", "escalation", keyFor, messages, deps, attempts);
  }
  return { attempts, final };
}
