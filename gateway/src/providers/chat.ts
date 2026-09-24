import { config, type ProviderName } from "../config";
import { retryAfterMs } from "../infra/backoff";

// Groq and OpenRouter both speak the OpenAI chat completions format.

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatResult {
  content: string;
  // The model that actually answered. With an OpenRouter model list this can be any of them.
  model: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  latencyMs: number;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly latencyMs: number,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = "ProviderError";
  }

  // Network errors, timeouts, rate limits, and server errors are worth retrying. An empty
  // answer or a 4xx is not.
  get retryable(): boolean {
    return this.status === null || this.status === 429 || this.status >= 500;
  }
}

interface CompletionResponse {
  model?: string;
  choices?: { message?: { content?: string | null } }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
  };
}

// One model, or an ordered list that OpenRouter tries until one answers.
export type ModelTarget = { model: string } | { models: string[] };

export async function chat(
  provider: ProviderName,
  apiKey: string,
  target: ModelTarget,
  messages: ChatMessage[],
): Promise<ChatResult> {
  const start = Date.now();
  const elapsed = () => Date.now() - start;
  const requested = "model" in target ? target.model : (target.models[0] ?? "");

  let res: Response;
  try {
    res = await fetch(`${config.providers[provider].baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        ...target,
        messages,
        max_completion_tokens: config.llm.maxOutputTokens,
        // Only the Groq models are reasoning models with an effort setting.
        ...(provider === "groq" ? { reasoning_effort: config.llm.reasoningEffort } : {}),
      }),
      signal: AbortSignal.timeout(config.llm.timeoutMs),
    });
  } catch (err) {
    throw new ProviderError(`${provider} request failed: ${String(err)}`, null, elapsed());
  }

  if (!res.ok) {
    const body = await res.text();
    throw new ProviderError(
      `${provider} returned ${res.status}: ${body.slice(0, 500)}`,
      res.status,
      elapsed(),
      retryAfterMs(res.headers.get("retry-after")),
    );
  }

  const data = (await res.json()) as CompletionResponse;
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) throw new ProviderError(`${provider} returned an empty answer`, res.status, elapsed());

  return {
    content,
    model: data.model ?? requested,
    inputTokens: data.usage?.prompt_tokens ?? 0,
    outputTokens: data.usage?.completion_tokens ?? 0,
    reasoningTokens: data.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
    latencyMs: elapsed(),
  };
}
