# jev-gateway-study

A small gateway that sits between an LLM app and its model providers, used to test [Jev](https://docs.typesafe.ai/introduction), a decision model from TypeSafe, as a prompt-injection screen and a model router.

Work in progress. So far:

- `experiments/`: tests of Jev as an injection screen. See the READMEs in [`smoke`](experiments/smoke), [`hard-cases`](experiments/hard-cases), and [`question-wording`](experiments/question-wording).
- `corpus/`: fictional business documents and questions for the demo app.
- `gateway/`: a Cloudflare Worker (Hono, D1) with `POST /v1/chat`. It screens the user message and every chunk with Jev in parallel, refuses a prompt-injection attempt in the user message, drops chunks that look like planted instructions, and asks Jev what kind of task the question is. Clear lookups and extractions go to the cheap model, everything else to the strong one. Every screening and routing decision is logged. If Groq fails it retries with backoff, then falls back to a list of free OpenRouter models, and if the cheap tier fails entirely it escalates to the strong tier. Jev calls go through a rate limiter and a circuit breaker.
- `apps/doc-qa/`: a small demo page. Pick a document from the corpus, ask a question, and see the answer plus the gateway's report, including each chunk's screening scores. It can plant a harmless test attack in a chunk so you can watch the gateway drop it.

## Run locally

Needs Node 22+.

```sh
npm install
cp gateway/.dev.vars.example gateway/.dev.vars   # then add your keys
npm run dev
```

This starts the gateway at http://localhost:8000 and doc-qa at http://localhost:5173.

To call the gateway directly:

```sh
curl -X POST localhost:8000/v1/chat \
  -H 'Content-Type: application/json' \
  -d '{"app_id": "demo", "user_message": "What is the total due?", "context_chunks": [{"id": "c1", "text": "Total due: $12,214.80"}]}'
```

The response has the answer plus a `gateway` block with the screening scores, dropped chunks, routing decision, model used, cost, and latency. `GET /v1/requests/:id` returns the logged record, including one row per screened text. Set `"options": {"classifier": "none"}` to skip screening, `"router": "none"` to always use the strong model, or `"force_tier": "cheap"` to pick a tier.

## Checks

```sh
npm run lint
npm run typecheck
npm test                 # gateway tests run inside the Workers runtime with a local D1
RUN_LIVE=1 npm test      # also calls the real Jev and OpenRouter APIs (needs keys in the environment)
```

## Stack

TypeScript on Cloudflare Workers, [Hono](https://hono.dev), [Zod](https://zod.dev), [Drizzle](https://orm.drizzle.team) with D1, Vitest, Biome. doc-qa is plain TypeScript built with Vite. LLM calls go to Groq (`openai/gpt-oss-20b` and `openai/gpt-oss-120b`), with free OpenRouter models as the fallback. Model names, prices, Jev questions, and thresholds live in [`config/default.json`](config/default.json).
