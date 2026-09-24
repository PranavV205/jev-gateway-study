import type { ChunkScore, Classifier, UserScore } from "./classifiers/base";
import { config } from "./config";
import { type ChunkReason, decideScreen, type ScreenDecision } from "./policy";
import type { Chunk } from "./schemas";

// A settled classifier call: the score if it worked, the error message if not.
export type Outcome<T> = { ok: true; score: T } | { ok: false; error: string; latencyMs: number };

export interface ScreenRun {
  classifier: string;
  user: Outcome<UserScore> | null;
  chunks: { id: string; outcome: Outcome<ChunkScore> }[];
  decision: ScreenDecision;
  costUsd: number;
  latencyMs: number;
}

export async function settle<T>(fn: () => Promise<T>): Promise<Outcome<T>> {
  const start = Date.now();
  try {
    return { ok: true, score: await fn() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), latencyMs: Date.now() - start };
  }
}

const NO_SCREEN: ScreenDecision = { action: "allowed", flagged: false, userReason: null, chunks: [] };

// Screens the user message and every chunk in parallel, then applies the policy.
export async function screen(classifier: Classifier | null, userMessage: string, chunks: Chunk[]): Promise<ScreenRun> {
  if (!classifier) {
    return {
      classifier: "none",
      user: null,
      chunks: [],
      decision: { ...NO_SCREEN, chunks: chunks.map((c) => ({ id: c.id, action: "kept", reason: null })) },
      costUsd: 0,
      latencyMs: 0,
    };
  }

  const start = Date.now();
  const [user, ...chunkOutcomes] = await Promise.all([
    settle(() => classifier.screenUser(userMessage)),
    ...chunks.map((c) => settle(() => classifier.screenChunk(c.text))),
  ]);
  const latencyMs = Date.now() - start;

  const userOutcome = user as Outcome<UserScore>;
  const chunkResults = chunks.map((c, i) => ({ id: c.id, outcome: chunkOutcomes[i] as Outcome<ChunkScore> }));

  const decision = decideScreen(
    { pInjection: userOutcome.ok ? userOutcome.score.pInjection : null },
    chunkResults.map(({ id, outcome }) => ({
      id,
      pInjection: outcome.ok ? outcome.score.pInjection : null,
      pExfil: outcome.ok ? outcome.score.pExfil : null,
    })),
    config.screening.thresholds,
    config.screening.failPolicy as { user: "allow" | "refuse"; chunk: "drop" | "keep" },
  );

  const costUsd = [userOutcome, ...chunkResults.map((c) => c.outcome)].reduce(
    (sum, o) => sum + (o.ok ? o.score.costUsd : 0),
    0,
  );

  return { classifier: classifier.name, user: userOutcome, chunks: chunkResults, decision, costUsd, latencyMs };
}

// The part of the screening result that goes back to the caller.
export function screenReport(run: ScreenRun) {
  if (run.classifier === "none") return null;
  const score = (o: Outcome<UserScore | ChunkScore> | null) => (o?.ok ? o.score.pInjection : null);
  const reasons = new Map<string, ChunkReason>(run.decision.chunks.map((c) => [c.id, c.reason]));
  return {
    classifier: run.classifier,
    flagged: run.decision.flagged,
    user: { p_injection: score(run.user), reason: run.decision.userReason },
    chunks: run.chunks.map(({ id, outcome }) => ({
      id,
      p_injection: score(outcome),
      p_exfil: outcome.ok ? outcome.score.pExfil : null,
      action: reasons.get(id) ? "dropped" : "kept",
      reason: reasons.get(id) ?? null,
    })),
  };
}
