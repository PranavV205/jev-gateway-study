import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { llmCalls, requests, routeDecisions, screenResults } from "./db/schema";
import { handleChat } from "./pipeline";
import { chatRequestSchema } from "./schemas";
import { listApps, loadStats, type Range } from "./stats";

const app = new Hono<{ Bindings: Env }>();

app.use("/v1/*", cors());

app.get("/healthz", (c) => c.json({ ok: true }));

app.post("/v1/chat", async (c) => {
  const parsed = chatRequestSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "invalid_request", issues: parsed.error.issues }, 400);
  }
  const res = await handleChat(c.env, parsed.data);
  return c.json(res, res.gateway.action === "error" ? 502 : 200);
});

app.get("/v1/requests/:id", async (c) => {
  const db = drizzle(c.env.DB);
  const id = c.req.param("id");
  const [request] = await db.select().from(requests).where(eq(requests.id, id));
  if (!request) return c.json({ error: "not_found" }, 404);
  const [screens, routes, calls] = await Promise.all([
    db.select().from(screenResults).where(eq(screenResults.requestId, id)),
    db.select().from(routeDecisions).where(eq(routeDecisions.requestId, id)),
    db.select().from(llmCalls).where(eq(llmCalls.requestId, id)),
  ]);
  return c.json({ request, screen_results: screens, route_decision: routes[0] ?? null, llm_calls: calls });
});

const RANGES: Range[] = ["24h", "7d", "30d", "all"];

app.get("/v1/stats", async (c) => {
  const range = (c.req.query("range") ?? "7d") as Range;
  if (!RANGES.includes(range)) return c.json({ error: "invalid_range", allowed: RANGES }, 400);
  const appId = c.req.query("app") || null;
  const [stats, apps] = await Promise.all([loadStats(c.env.DB, range, appId), listApps(c.env.DB)]);
  return c.json({ ...stats, app: appId, apps });
});

export default app;
