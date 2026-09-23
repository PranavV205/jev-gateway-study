# jev-gateway-study

A small gateway that sits between an LLM app and its model providers, used to test [Jev](https://docs.typesafe.ai/introduction), a decision model from TypeSafe, as a prompt-injection screen and a model router.

Work in progress. So far:

- `experiments/`: tests of Jev as an injection screen. See the READMEs in [`smoke`](experiments/smoke), [`hard-cases`](experiments/hard-cases), and [`question-wording`](experiments/question-wording).
- `corpus/`: fictional business documents and questions for the demo app.
- `gateway/`: a Cloudflare Worker (Hono, D1) with `POST /v1/chat`. It currently sends every request to the strong model and logs it. Screening and routing are not wired in yet.

## Run the gateway locally

Needs Node 22+.

```sh
npm install
cp gateway/.dev.vars.example gateway/.dev.vars   # then add your keys
npm run dev                                      # http://localhost:8787
```

```sh
curl -X POST localhost:8787/v1/chat \
  -H 'Content-Type: application/json' \
  -d '{"app_id": "demo", "user_message": "What is the total due?", "context_chunks": [{"id": "c1", "text": "Total due: $12,214.80"}]}'
```

The response has the answer plus a `gateway` block with the model used, cost, and latency. `GET /v1/requests/:id` returns the logged record.

## Checks

```sh
npm run lint
npm run typecheck
npm test                 # runs inside the Workers runtime with a local D1
RUN_LIVE=1 npm test      # also calls the real Jev API (needs keys in the environment)
```

## Stack

TypeScript on Cloudflare Workers, [Hono](https://hono.dev), [Zod](https://zod.dev), [Drizzle](https://orm.drizzle.team) with D1, Vitest, Biome. LLM calls go to Groq (`openai/gpt-oss-20b` and `openai/gpt-oss-120b`). Model names, prices, Jev questions, and thresholds live in [`config/default.json`](config/default.json).
