// A classifier scores texts for prompt injection. Jev is the main one; baselines
// (keyword, Prompt Guard, LLM judge) will implement the same interface so the
// gateway and the evaluation can swap them freely.

export interface CallMeta {
  model: string;
  inputTokens: number;
  costUsd: number;
  latencyMs: number;
  raw: unknown;
}

export interface UserScore extends CallMeta {
  pInjection: number;
}

export interface ChunkScore extends CallMeta {
  pInjection: number;
  pExfil: number | null;
}

export interface Classifier {
  name: string;
  screenUser(text: string): Promise<UserScore>;
  screenChunk(text: string): Promise<ChunkScore>;
}

export interface RouteScore extends CallMeta {
  taskType: string;
  taskProbs: Record<string, number>;
  confidence: number;
  pNeedsStrong: number;
}

// A router classifies the user's question so the gateway can pick a model tier.
export interface Router {
  name: string;
  route(question: string): Promise<RouteScore>;
}
