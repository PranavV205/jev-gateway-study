import { choice, noul, TypeSafeClient } from "@typesafe-ai/sdk";
import { config, costUsd } from "../config";
import { CircuitBreaker } from "../infra/circuit";
import { TokenBucket } from "../infra/ratelimit";
import type { ChunkScore, Classifier, Router, RouteScore, UserScore } from "./base";

const { questions } = config.screening;
const ask = (q: { instructions: string; criteria: { true: string; false: string } }) =>
  noul(q.instructions, q.criteria);

const userQuestions = { user_injection: ask(questions.user_injection) };
const chunkQuestions = {
  chunk_injection: ask(questions.chunk_injection),
  exfiltration: ask(questions.exfiltration),
};

const routing = config.routing.questions;
const routeQuestions = {
  task_type: choice(routing.task_type.instructions, routing.task_type.criteria),
  needs_strong: noul(routing.needs_strong.instructions),
};

// Shared by every request handled by this Worker instance.
export const jevBreaker = new CircuitBreaker(
  "jev",
  config.jev.circuitBreaker.failureThreshold,
  config.jev.circuitBreaker.cooldownMs,
);
export const jevBucket = new TokenBucket(config.jev.rateLimit.requestsPerSecond, config.jev.rateLimit.burst);

export class JevClassifier implements Classifier, Router {
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
    const res = await this.call(text, userQuestions);
    return {
      pInjection: res.answers.user_injection.noul,
      ...this.meta(res, start),
    };
  }

  async screenChunk(text: string): Promise<ChunkScore> {
    const start = Date.now();
    const res = await this.call(text, chunkQuestions);
    return {
      pInjection: res.answers.chunk_injection.noul,
      pExfil: res.answers.exfiltration.noul,
      ...this.meta(res, start),
    };
  }

  async route(question: string): Promise<RouteScore> {
    const start = Date.now();
    const res = await this.call(question, routeQuestions);
    const task = res.answers.task_type;
    return {
      taskType: task.choice,
      taskProbs: { ...task.probabilities },
      confidence: task.confidence,
      pNeedsStrong: res.answers.needs_strong.noul,
      ...this.meta(res, start),
    };
  }

  // Every Jev call waits for a rate-limit token and goes through the circuit breaker, so a
  // Jev outage costs one fast rejection per call instead of a timeout and a retry.
  private call<Q extends Parameters<TypeSafeClient["systemOne"]>[0]["questions"]>(state: string, questions: Q) {
    return jevBreaker.run(async () => {
      await jevBucket.take();
      return this.client.systemOne({ state, questions });
    });
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
