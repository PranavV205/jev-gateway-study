// Screening decisions. Pure functions: scores in, actions out.

export interface Thresholds {
  userInjection: number;
  chunkInjection: number;
  exfiltration: number;
}

export interface FailPolicy {
  user: "allow" | "refuse";
  chunk: "drop" | "keep";
}

// A score of null means the text could not be screened (timeout, error).
export interface UserInput {
  pInjection: number | null;
}

export interface ChunkInput {
  id: string;
  pInjection: number | null;
  pExfil: number | null;
}

export type ChunkAction = "kept" | "dropped";
export type ChunkReason = "injection" | "exfiltration" | "screen_failed" | null;

export interface ScreenDecision {
  action: "allowed" | "refused";
  // True when the user message could not be screened but was let through.
  flagged: boolean;
  userReason: "injection" | "screen_failed" | null;
  chunks: { id: string; action: ChunkAction; reason: ChunkReason }[];
}

export function decideChunk(chunk: ChunkInput, t: Thresholds, fail: FailPolicy): ChunkReason {
  if (chunk.pInjection === null) return fail.chunk === "drop" ? "screen_failed" : null;
  if (chunk.pInjection >= t.chunkInjection) return "injection";
  if (chunk.pExfil !== null && chunk.pExfil >= t.exfiltration) return "exfiltration";
  return null;
}

export function decideScreen(user: UserInput, chunks: ChunkInput[], t: Thresholds, fail: FailPolicy): ScreenDecision {
  const chunkDecisions = chunks.map((c) => {
    const reason = decideChunk(c, t, fail);
    return { id: c.id, action: (reason ? "dropped" : "kept") as ChunkAction, reason };
  });

  if (user.pInjection === null) {
    const refuse = fail.user === "refuse";
    return {
      action: refuse ? "refused" : "allowed",
      flagged: !refuse,
      userReason: "screen_failed",
      chunks: chunkDecisions,
    };
  }

  const refused = user.pInjection >= t.userInjection;
  return {
    action: refused ? "refused" : "allowed",
    flagged: false,
    userReason: refused ? "injection" : null,
    chunks: chunkDecisions,
  };
}
