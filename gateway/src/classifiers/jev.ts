import { noul, TypeSafeClient } from "@typesafe-ai/sdk";
import { config, costUsd } from "../config";
import type { ChunkScore, Classifier, UserScore } from "./base";

const { questions } = config.screening;
const ask = (q: { instructions: string; criteria: { true: string; false: string } }) =>
  noul(q.instructions, q.criteria);

const userQuestions = { user_injection: ask(questions.user_injection) };
const chunkQuestions = {
  chunk_injection: ask(questions.chunk_injection),
  exfiltration: ask(questions.exfiltration),
};

export class JevClassifier implements Classifier {
  readonly name = "jev";
  private readonly client: TypeSafeClient;

  constructor(apiKey: string) {
    this.client = new TypeSafeClient({
      apiKey,
      defaultModel: config.jev.model,
      timeout: config.jev.timeoutMs,
      retry: { maxRetries: config.jev.maxRetries },
    });
  }

  async screenUser(text: string): Promise<UserScore> {
    const start = Date.now();
    const res = await this.client.systemOne({ state: text, questions: userQuestions });
    return {
      pInjection: res.answers.user_injection.noul,
      ...this.meta(res, start),
    };
  }

  async screenChunk(text: string): Promise<ChunkScore> {
    const start = Date.now();
    const res = await this.client.systemOne({ state: text, questions: chunkQuestions });
    return {
      pInjection: res.answers.chunk_injection.noul,
      pExfil: res.answers.exfiltration.noul,
      ...this.meta(res, start),
    };
  }

  private meta(res: { model: string; usage: { input_tokens: number } }, start: number) {
    return {
      model: res.model,
      inputTokens: res.usage.input_tokens,
      costUsd: costUsd(res.model, res.usage.input_tokens, 0),
      latencyMs: Date.now() - start,
      raw: res,
    };
  }
}
