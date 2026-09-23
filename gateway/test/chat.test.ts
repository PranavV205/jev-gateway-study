import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";

const groqReply = {
  choices: [{ message: { content: "The total due is $12,214.80." } }],
  usage: { prompt_tokens: 400, completion_tokens: 60, completion_tokens_details: { reasoning_tokens: 20 } },
};

function mockProvider(status: number, body: unknown) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
}

async function call(method: string, path: string, body?: unknown) {
  const ctx = createExecutionContext();
  const res = await app.fetch(
    new Request(`http://gateway.test${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

const validRequest = {
  app_id: "doc-qa",
  user_message: "What is the total due?",
  context_chunks: [{ id: "c1", text: "Total due: $12,214.80", source: "invoice-northwind-2041.md#1" }],
};

afterEach(() => vi.restoreAllMocks());

describe("GET /healthz", () => {
  it("returns ok", async () => {
    const res = await call("GET", "/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("POST /v1/chat", () => {
  it("answers on the strong tier and logs the request", async () => {
    const fetchSpy = mockProvider(200, groqReply);

    const res = await call("POST", "/v1/chat", validRequest);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { answer: string; gateway: Record<string, unknown> };

    expect(body.answer).toBe("The total due is $12,214.80.");
    expect(body.gateway).toMatchObject({ action: "allowed", tier: "strong", model: "openai/gpt-oss-120b" });
    // 400 input and 60 output tokens at $0.15 / $0.60 per million
    expect(body.gateway.cost_usd).toBeCloseTo(0.000096);

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.groq.com/openai/v1/chat/completions");
    const sent = JSON.parse(init.body as string);
    expect(sent.model).toBe("openai/gpt-oss-120b");
    expect(sent.messages[1].content).toContain("Total due: $12,214.80");

    const trace = await call("GET", `/v1/requests/${body.gateway.request_id}`);
    const { request, llm_calls } = (await trace.json()) as {
      request: Record<string, unknown>;
      llm_calls: Record<string, unknown>[];
    };
    expect(request).toMatchObject({ appId: "doc-qa", chunkCount: 1, action: "allowed" });
    expect(request.userMessageHash).toMatch(/^[0-9a-f]{64}$/);
    expect(llm_calls).toHaveLength(1);
    expect(llm_calls[0]).toMatchObject({ inputTokens: 400, outputTokens: 60, reasoningTokens: 20, status: "ok" });
  });

  it("uses the cheap tier when forced", async () => {
    mockProvider(200, groqReply);
    const res = await call("POST", "/v1/chat", { ...validRequest, options: { force_tier: "cheap" } });
    const body = (await res.json()) as { gateway: Record<string, unknown> };
    expect(body.gateway).toMatchObject({ tier: "cheap", model: "openai/gpt-oss-20b" });
    expect(body.gateway.baseline_cost_usd).toBeGreaterThan(body.gateway.cost_usd as number);
  });

  it("skips the model call on a dry run", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const res = await call("POST", "/v1/chat", { ...validRequest, options: { dry_run: true } });
    const body = (await res.json()) as { answer: unknown; gateway: Record<string, unknown> };
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(body.answer).toBeNull();
    expect(body.gateway.cost_usd).toBe(0);
  });

  it("returns 502 and logs the error when the provider fails", async () => {
    mockProvider(429, { error: { message: "Rate limit reached" } });
    const res = await call("POST", "/v1/chat", validRequest);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { gateway: { request_id: string; action: string; error: string } };
    expect(body.gateway.action).toBe("error");
    expect(body.gateway.error).toContain("429");

    const trace = await call("GET", `/v1/requests/${body.gateway.request_id}`);
    const { llm_calls } = (await trace.json()) as { llm_calls: Record<string, unknown>[] };
    expect(llm_calls[0]).toMatchObject({ status: "error" });
  });

  it("rejects an invalid body", async () => {
    const res = await call("POST", "/v1/chat", { app_id: "doc-qa" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_request" });
  });

  it("returns 404 for an unknown request id", async () => {
    const res = await call("GET", "/v1/requests/does-not-exist");
    expect(res.status).toBe(404);
  });
});
