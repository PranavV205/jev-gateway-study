import { config, type ProviderName } from "../config";

// Groq and OpenRouter both speak the OpenAI chat completions format.

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatResult {
  content: string;
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
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

interface CompletionResponse {
  choices?: { message?: { content?: string | null } }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
  };
}

export async function chat(
  provider: ProviderName,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
): Promise<ChatResult> {
  const start = Date.now();
  const elapsed = () => Date.now() - start;

  let res: Response;
  try {
    res = await fetch(`${config.providers[provider].baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        max_completion_tokens: config.llm.maxOutputTokens,
        reasoning_effort: config.llm.reasoningEffort,
      }),
      signal: AbortSignal.timeout(config.llm.timeoutMs),
    });
  } catch (err) {
    throw new ProviderError(`${provider} request failed: ${String(err)}`, null, elapsed());
  }

  if (!res.ok) {
    const body = await res.text();
    throw new ProviderError(`${provider} returned ${res.status}: ${body.slice(0, 500)}`, res.status, elapsed());
  }

  const data = (await res.json()) as CompletionResponse;
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) throw new ProviderError(`${provider} returned an empty answer`, res.status, elapsed());

  return {
    content,
    inputTokens: data.usage?.prompt_tokens ?? 0,
    outputTokens: data.usage?.completion_tokens ?? 0,
    reasoningTokens: data.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
    latencyMs: elapsed(),
  };
}
