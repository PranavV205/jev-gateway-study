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
