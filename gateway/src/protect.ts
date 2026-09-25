// Protection for a public demo: which browser origins may call the API, a per-visitor
// rate limit, and a site-wide daily cap on chat requests, so strangers can't drain the
// free-tier quotas behind the gateway.

import type { Context, Next } from "hono";

type AppContext = Context<{ Bindings: Env }>;

// Returns the origin to echo back in CORS headers, or null to refuse it.
export function allowedOrigin(origin: string, env: Env): string | null {
  const allowed = (env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  if (allowed.includes("*")) return origin || "*";
  return allowed.includes(origin) ? origin : null;
}

export function startOfUtcDay(now: Date): string {
  return `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
}

export async function requestsToday(db: D1Database, now = new Date()): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM requests WHERE created_at >= ?")
    .bind(startOfUtcDay(now))
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// Runs before POST /v1/chat.
export async function chatGuard(c: AppContext, next: Next) {
  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  if (c.env.CHAT_LIMITER) {
    const { success } = await c.env.CHAT_LIMITER.limit({ key: ip });
    if (!success) {
      c.header("Retry-After", "60");
      return c.json({ error: "rate_limited", message: "Too many questions. The demo allows 10 a minute." }, 429);
    }
  }

  const cap = Number(c.env.DAILY_REQUEST_CAP);
  if (Number.isFinite(cap) && cap > 0 && (await requestsToday(c.env.DB)) >= cap) {
    return c.json(
      {
        error: "daily_limit",
        message: `The demo has reached today's limit of ${cap} questions. It resets at midnight UTC.`,
      },
      429,
    );
  }
  await next();
}
